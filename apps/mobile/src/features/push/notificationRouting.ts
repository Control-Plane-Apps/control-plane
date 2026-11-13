import {
  PUSH_ACTION_REPLY,
  type PushNotificationData,
  type PushNotificationKind,
} from "@t3tools/contracts";

// Fork-owned. Where a tap on a Control Plane notification goes. Pure, so the
// routing is testable without expo-notifications.

const DEFAULT_ACTION = "expo.modules.notifications.actions.DEFAULT";
const KINDS: ReadonlySet<PushNotificationKind> = new Set([
  "status-question",
  "agent-finished",
  "task-reminder",
  "assistant",
]);

export function controlPlanePushData(data: unknown): PushNotificationData | null {
  if (typeof data !== "object" || data === null) return null;
  // APNs custom keys arrive at the top level of `data`; the payload nests ours under `cp`.
  const nested = (data as { readonly cp?: unknown }).cp;
  const candidate = typeof nested === "object" && nested !== null ? nested : data;
  const record = candidate as Partial<PushNotificationData>;
  if (record.cp !== 1 || typeof record.kind !== "string" || !KINDS.has(record.kind)) return null;
  if (typeof record.environmentId !== "string" || record.environmentId.length === 0) return null;
  return record as PushNotificationData;
}

export type PushRoute =
  | { readonly kind: "link"; readonly path: string }
  | {
      readonly kind: "reply";
      readonly path: string;
      readonly environmentId: string;
      readonly threadId: string;
      readonly tag: {
        readonly title: string;
        readonly statusId: string;
        readonly openedAt?: string;
      };
    }
  | { readonly kind: "none" };

const SAFE_SEGMENT = /^[^/?#]+$/;

function threadPath(environmentId: string, threadId: string): string | null {
  if (!SAFE_SEGMENT.test(environmentId) || !SAFE_SEGMENT.test(threadId)) return null;
  return `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

/**
 * Reply opens the coordinator's composer with the Re: chip for that question
 * version. A plain tap on a question opens Status; anything else opens its
 * thread. Answer, Complete and Snooze never reach here: the native handler
 * runs them without opening the app.
 */
export function routeForPushResponse(
  data: PushNotificationData,
  actionIdentifier: string,
): PushRoute {
  const thread = data.threadId === undefined ? null : threadPath(data.environmentId, data.threadId);
  if (data.kind === "status-question" && data.statusId !== undefined && thread !== null) {
    if (actionIdentifier === PUSH_ACTION_REPLY) {
      return {
        kind: "reply",
        path: thread,
        environmentId: data.environmentId,
        threadId: data.threadId!,
        tag: {
          title: data.statusTitle ?? data.statusId,
          statusId: data.statusId,
          ...(data.openedAt === undefined ? {} : { openedAt: data.openedAt }),
        },
      };
    }
    if (actionIdentifier === DEFAULT_ACTION && data.projectId !== undefined) {
      if (!SAFE_SEGMENT.test(data.projectId)) return { kind: "link", path: thread };
      return {
        kind: "link",
        path: `/projects/${encodeURIComponent(data.environmentId)}/${encodeURIComponent(data.projectId)}/status`,
      };
    }
  }
  if (actionIdentifier !== DEFAULT_ACTION) return { kind: "none" };
  if (thread !== null) return { kind: "link", path: thread };
  if (data.kind === "task-reminder") return { kind: "link", path: "/tasks" };
  return { kind: "none" };
}
