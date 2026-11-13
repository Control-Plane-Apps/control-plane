import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { collectPings } from "@t3tools/client-runtime/state/assistant-home";
import { useEffect, useMemo, useRef } from "react";

import { useThreadDetail } from "~/state/entities";
import { toastManager } from "../ui/toast";
import { AssistantMark } from "./AssistantMark";
import { useGlobalAssistantProject, useSendToThread } from "./useAssistant";

// Fork-owned. Shows each new Assistant ping once as a toast: its title, the
// question, the one recommended reply and "Not now". Pings older than a few
// minutes when the app opens stay in the Inbox only.

const SEEN_KEY = "cplane:assistant-pings-seen:v1";
const FRESH_MS = 10 * 60 * 1000;

function readSeen(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeSeen(seen: Set<string>) {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200)));
  } catch {
    // Storage full or blocked: a ping may show again, which is harmless.
  }
}

export function AssistantPingToasts() {
  const project = useGlobalAssistantProject();
  const ref = useMemo(
    () =>
      project?.assistant != null
        ? scopeThreadRef(project.environmentId, project.assistant.coordinatorThreadId)
        : null,
    [project],
  );
  const thread = useThreadDetail(ref);
  const send = useSendToThread();
  const seenRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (thread === null || ref === null) return;
    seenRef.current ??= readSeen();
    const seen = seenRef.current;
    const now = Date.now();
    let changed = false;
    for (const ping of collectPings(thread.activities)) {
      if (seen.has(ping.pingId)) continue;
      seen.add(ping.pingId);
      changed = true;
      if (now - Date.parse(ping.createdAt) > FRESH_MS) continue;
      const action = ping.actions[0];
      const toastId = toastManager.add({
        type: "info",
        title: ping.title,
        ...(ping.body ? { description: ping.body } : {}),
        timeout: 0,
        ...(action
          ? {
              actionProps: {
                children: action.label,
                onClick: () => {
                  void send({
                    environmentId: ref.environmentId,
                    threadId: ref.threadId,
                    text: action.reply,
                    runtimeMode: thread.runtimeMode,
                  });
                  toastManager.close(toastId);
                },
              },
            }
          : {}),
        data: {
          hideCopyButton: true,
          leadingIcon: <AssistantMark className="size-3.5 text-attention-foreground" />,
          actionLayout: "stacked-start",
          actionVariant: "default",
          secondaryActionProps: {
            children: "Not now",
            onClick: () => toastManager.close(toastId),
          },
          secondaryActionVariant: "outline",
        },
      });
    }
    if (changed) writeSeen(seen);
  }, [ref, send, thread]);

  return null;
}
