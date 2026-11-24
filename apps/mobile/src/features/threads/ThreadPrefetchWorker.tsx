import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Notifications from "expo-notifications";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { useThreadShells } from "../../state/entities";
import { getThreadVisitMap } from "../../state/thread-visits";
import { environmentThreads } from "../../state/threads";
import { useWorkspaceState } from "../../state/workspace";
import { controlPlanePushData } from "../push/notificationRouting";
import {
  createPrefetchQueue,
  isWarm,
  PREFETCH_FOREGROUND_COOLDOWN_MS,
  PREFETCH_PERSIST_GRACE_MS,
  PREFETCH_TIMEOUT_MS,
  type PrefetchTarget,
  selectPrefetchTargets,
  type ThreadWarmer,
} from "./threadPrefetch";

// Fork-owned. Warms likely threads when the app comes to the foreground and
// when a notification for a thread arrives or is tapped. See threadPrefetch.ts.

/** Let launch settle (Home paint, connections) before warming threads. */
const FOREGROUND_SETTLE_MS = 1_500;

const atomWarmer: ThreadWarmer = {
  warm: (target) =>
    new Promise<void>((resolve) => {
      const atom = environmentThreads.stateAtom(target.environmentId, target.threadId);
      const release = appAtomRegistry.mount(atom);
      let finished = false;
      let unsubscribe: (() => void) | undefined;
      const finish = (delayMs: number) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        unsubscribe?.();
        setTimeout(() => {
          release();
          resolve();
        }, delayMs);
      };
      const timeout = setTimeout(() => finish(0), PREFETCH_TIMEOUT_MS);
      unsubscribe = appAtomRegistry.subscribe(
        atom,
        (result) => {
          const state = Option.getOrNull(
            AsyncResult.value(result),
          ) as EnvironmentThreadState | null;
          if (state !== null && isWarm(state)) finish(PREFETCH_PERSIST_GRACE_MS);
        },
        { immediate: true },
      );
      if (finished) unsubscribe();
    }),
};

/**
 * expo-notifications reports a remote push's `content.data` as its `body` key
 * (NotificationRecords.swift), which our payloads do not use; the whole APNs
 * payload, `cp` included, is on the push trigger.
 */
function pushData(request: Notifications.NotificationRequest): unknown {
  const trigger = request.trigger as { readonly payload?: unknown } | null;
  return controlPlanePushData(request.content.data) !== null
    ? request.content.data
    : (trigger?.payload ?? null);
}

function pushTarget(request: Notifications.NotificationRequest): PrefetchTarget | null {
  const push = controlPlanePushData(pushData(request));
  if (push === null || typeof push.threadId !== "string" || push.threadId.length === 0) {
    return null;
  }
  return {
    environmentId: EnvironmentId.make(push.environmentId),
    threadId: ThreadId.make(push.threadId),
  };
}

export function ThreadPrefetchWorker() {
  const threads = useThreadShells();
  const { environments } = useWorkspaceState();
  const connectedKey = environments
    .filter((environment) => environment.connectionState === "connected")
    .map((environment) => environment.environmentId)
    .sort()
    .join(",");
  const queue = useMemo(() => createPrefetchQueue(atomWarmer), []);
  // Re-arms the pass when the shell first lands after connect.
  const threadsLoaded = threads.length > 0;

  const threadsRef = useRef(threads);
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);
  const lastPassAt = useRef(0);
  const passPending = useRef(true);

  // Foreground pass: on launch and on every return to the app, once at least
  // one environment is connected, after a short settle.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") passPending.current = true;
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (connectedKey.length === 0 || !threadsLoaded) return;
    const id = setTimeout(() => {
      if (!passPending.current || AppState.currentState !== "active") return;
      if (Date.now() - lastPassAt.current < PREFETCH_FOREGROUND_COOLDOWN_MS) {
        passPending.current = false;
        return;
      }
      passPending.current = false;
      lastPassAt.current = Date.now();
      queue.enqueue(
        selectPrefetchTargets({
          threads: threadsRef.current,
          lastVisitedAtByKey: getThreadVisitMap(),
          connectedEnvironmentIds: new Set(connectedKey.split(",") as EnvironmentId[]),
          nowMs: Date.now(),
        }),
      );
    }, FOREGROUND_SETTLE_MS);
    return () => clearTimeout(id);
  }, [connectedKey, queue, threadsLoaded]);

  // A notification about a thread: warm that thread first.
  useEffect(() => {
    const received = Notifications.addNotificationReceivedListener((notification) => {
      const target = pushTarget(notification.request);
      if (target !== null) queue.enqueue([target], { front: true });
    });
    const tapped = Notifications.addNotificationResponseReceivedListener((response) => {
      const target = pushTarget(response.notification.request);
      if (target !== null) queue.enqueue([target], { front: true });
    });
    return () => {
      received.remove();
      tapped.remove();
    };
  }, [queue]);

  return null;
}
