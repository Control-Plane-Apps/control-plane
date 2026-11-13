import { useAtomValue } from "@effect/atom-react";
import { useLinkTo } from "@react-navigation/native";
import {
  EnvironmentId,
  ThreadId,
  PUSH_ACTION_COMPLETE,
  PUSH_ACTION_REPLY,
  PUSH_ACTION_SNOOZE,
  PUSH_CATEGORY_STATUS_QUESTION,
  PUSH_CATEGORY_TASK_REMINDER,
  type PushNotificationLevel,
} from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef } from "react";
import { AppState, Platform } from "react-native";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import { mobilePreferencesAtom } from "../../state/preferences";
import {
  useRemoteConnectionStatus,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { supportsAgentAwarenessPush } from "../agent-awareness/capabilities";
import { resolveApsEnvironment } from "../agent-awareness/registrationPayload";
import { consumeLastAgentNotificationResponse } from "../agent-awareness/notificationResponseConsumer";
import { setStatusReplyTag } from "../status/statusReplyStore";
import { controlPlanePushData, routeForPushResponse } from "./notificationRouting";
import {
  canRegisterPushWith,
  pushRegistrationBody,
  pushRegistrationSignature,
  registerPushWithEnvironment,
} from "./pushRegistration";

// Fork-owned. iPhone lock-screen notifications from the Mac. This null
// component registers the phone with every connected Mac, sets up the
// notification buttons, and routes taps. Answer, Complete and Snooze run in
// the native CPPushActions handler, so they work with the app closed.

let categoriesReady: Promise<void> | null = null;

/**
 * Static categories. A Status question's own category, with its answer label
 * on the first button, is made per notification by the Notification Service
 * Extension; this one is the fallback without the answer button.
 */
export function ensureControlPlaneNotificationCategories(): Promise<void> {
  // One at a time: each call reads the current set and writes it back, so
  // concurrent calls would drop each other's category.
  categoriesReady ??= (async () => {
    await Notifications.setNotificationCategoryAsync(PUSH_CATEGORY_STATUS_QUESTION, [
      {
        identifier: PUSH_ACTION_REPLY,
        buttonTitle: "Reply",
        options: { opensAppToForeground: true },
      },
      {
        identifier: PUSH_ACTION_SNOOZE,
        buttonTitle: "Snooze 1 hour",
        options: { opensAppToForeground: false },
      },
    ]);
    await Notifications.setNotificationCategoryAsync(PUSH_CATEGORY_TASK_REMINDER, [
      {
        identifier: PUSH_ACTION_COMPLETE,
        buttonTitle: "Complete",
        options: { opensAppToForeground: false },
      },
      {
        identifier: PUSH_ACTION_SNOOZE,
        buttonTitle: "Snooze 1 hour",
        options: { opensAppToForeground: false },
      },
    ]);
  })().catch((error: unknown) => {
    categoriesReady = null;
    console.warn("Control Plane notification categories failed", error);
  });
  return categoriesReady;
}

function usePushLevel(): PushNotificationLevel | undefined {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences) ? preferences.value.pushNotificationLevel : undefined;
}

function useControlPlanePushRegistration(): void {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const level = usePushLevel();
  const sent = useRef(new Map<string, string>());
  const connectedKey = useMemo(
    () =>
      connectedEnvironments
        .filter((environment) => environment.connectionState === "connected")
        .map((environment) => environment.environmentId)
        .sort()
        .join(","),
    [connectedEnvironments],
  );

  useEffect(() => {
    if (Platform.OS !== "ios" || !supportsAgentAwarenessPush()) return;
    let cancelled = false;
    const run = async () => {
      const permissions = await Notifications.getPermissionsAsync();
      if (!permissions.granted || cancelled) return;
      await ensureControlPlaneNotificationCategories();
      const token = await Notifications.getDevicePushTokenAsync();
      const deviceId = await loadOrCreateAgentAwarenessDeviceId();
      const bundleId = Constants.expoConfig?.ios?.bundleIdentifier;
      if (cancelled || typeof token.data !== "string" || bundleId === undefined) return;
      const connected = new Set(connectedKey.split(","));
      for (const connection of Object.values(savedConnectionsById)) {
        if (!connected.has(connection.environmentId) || !canRegisterPushWith(connection)) continue;
        const body = pushRegistrationBody(connection, {
          deviceId,
          apnsToken: token.data,
          apsEnvironment: resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant),
          bundleId,
          level,
        });
        const signature = pushRegistrationSignature(body);
        if (sent.current.get(connection.environmentId) === signature) continue;
        const ok = await registerPushWithEnvironment(connection, body).catch(() => false);
        if (ok) sent.current.set(connection.environmentId, signature);
      }
    };
    void run().catch((error: unknown) =>
      console.warn("Control Plane push registration failed", error),
    );
    const tokens = Notifications.addPushTokenListener(() => {
      sent.current.clear();
      void run().catch(() => undefined);
    });
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") void run().catch(() => undefined);
    });
    return () => {
      cancelled = true;
      tokens.remove();
      foreground.remove();
    };
  }, [connectedKey, level, savedConnectionsById]);
}

function useControlPlanePushRouting(): void {
  const linkTo = useLinkTo();
  const handled = useRef(new Set<string>());

  useEffect(() => {
    const handleResponse = (response: Notifications.NotificationResponse) => {
      const id = `${response.notification.request.identifier}:${response.actionIdentifier}`;
      if (handled.current.has(id)) return;
      const data = controlPlanePushData(response.notification.request.content.data);
      if (data === null) return;
      handled.current.add(id);
      const route = routeForPushResponse(data, response.actionIdentifier);
      if (route.kind === "reply") {
        setStatusReplyTag(
          scopedThreadKey(EnvironmentId.make(route.environmentId), ThreadId.make(route.threadId)),
          route.tag,
        );
        linkTo(route.path);
      } else if (route.kind === "link") {
        linkTo(route.path);
      }
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
    void consumeLastAgentNotificationResponse({
      getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
      // The agent-awareness consumer clears it once it has seen it too.
      clearLastResponse: async () => undefined,
      handleResponse,
    });
    return () => subscription.remove();
  }, [linkTo]);
}

export function ControlPlanePushWorker() {
  useControlPlanePushRegistration();
  useControlPlanePushRouting();
  return null;
}
