/**
 * Builds the APNs bodies for Control Plane's iPhone notifications. Fork-owned
 * and pure, so the copy and the action wiring are testable without APNs.
 *
 * @module pushPayloads
 */
import * as NodeCrypto from "node:crypto";

import {
  PUSH_ACTION_ROUTE_PATH,
  PUSH_CATEGORY_AGENT,
  PUSH_CATEGORY_ASSISTANT,
  PUSH_CATEGORY_STATUS_QUESTION,
  PUSH_CATEGORY_TASK_REMINDER,
  type PushNotificationData,
  type PushNotificationKind,
  type PushNotificationLevel,
} from "@t3tools/contracts";

export interface ApnsPayload {
  readonly aps: {
    readonly alert: { readonly title: string; readonly body: string };
    readonly sound?: "default";
    readonly category?: string;
    readonly "mutable-content"?: 1;
    readonly "thread-id"?: string;
    readonly "interruption-level"?: "passive" | "active";
  };
  readonly cp: PushNotificationData;
}

export interface PushMessage {
  readonly kind: PushNotificationKind;
  /** Notifications with the same key replace each other on the phone. */
  readonly collapseKey: string;
  readonly payload: ApnsPayload;
}

/** Which kinds a level lets through. Needs-you questions, task reminders and Assistant pings ask for the user. */
export function levelAllows(level: PushNotificationLevel, kind: PushNotificationKind): boolean {
  if (level === "off") return false;
  if (level === "all") return true;
  return kind !== "agent-finished";
}

const ALERT_TITLE_MAX = 80;
const ALERT_BODY_MAX = 240;

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1).trimEnd()}…`;
}

export function threadDeepLink(environmentId: string, threadId: string): string {
  return `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

/** APNs caps `apns-collapse-id` at 64 bytes. */
export function apnsCollapseId(key: string): string {
  return key.length <= 64
    ? key
    : NodeCrypto.createHash("sha256").update(key).digest("hex").slice(0, 64);
}

/** The phone's base URL plus the action route, without a doubled slash. */
export function pushActionUrl(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, "")}${PUSH_ACTION_ROUTE_PATH}`;
}

export interface StatusQuestionInput {
  readonly environmentId: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly coordinatorThreadId: string;
  readonly statusId: string;
  readonly statusTitle: string;
  readonly question: string;
  readonly answerLabel: string;
  readonly openedAt: string;
}

/**
 * "Payments retry needs you" / the question, with the Project and the
 * recommendation on the line below (shown when expanded). The answer button's
 * label rides in `cp.answerLabel`; the Notification Service Extension turns it
 * into this notification's own category.
 */
export function statusQuestionMessage(
  input: StatusQuestionInput,
  action: { readonly url: string; readonly token: string } | null,
): PushMessage {
  const question = clip(input.question, ALERT_BODY_MAX);
  return {
    kind: "status-question",
    collapseKey: apnsCollapseId(`status:${input.projectId}:${input.statusId}`),
    payload: {
      aps: {
        alert: {
          title: clip(`${input.statusTitle} needs you`, ALERT_TITLE_MAX),
          body: `${question}\n${clip(input.projectTitle, 40)} · Recommended: ${input.answerLabel}`,
        },
        sound: "default",
        category: PUSH_CATEGORY_STATUS_QUESTION,
        "mutable-content": 1,
        "thread-id": `status:${input.projectId}`,
        "interruption-level": "active",
      },
      cp: {
        cp: 1,
        kind: "status-question",
        environmentId: input.environmentId,
        deepLink: threadDeepLink(input.environmentId, input.coordinatorThreadId),
        threadId: input.coordinatorThreadId,
        projectId: input.projectId,
        statusId: input.statusId,
        statusTitle: input.statusTitle,
        openedAt: input.openedAt,
        answerLabel: input.answerLabel,
        ...(action === null ? {} : { actionUrl: action.url, actionToken: action.token }),
      },
    },
  };
}

export interface AgentFinishedInput {
  readonly environmentId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly projectTitle: string;
  readonly failed: boolean;
}

export function agentFinishedMessage(input: AgentFinishedInput): PushMessage {
  return {
    kind: "agent-finished",
    collapseKey: apnsCollapseId(`thread:${input.threadId}`),
    payload: {
      aps: {
        alert: {
          title: clip(input.threadTitle, ALERT_TITLE_MAX),
          body: `${input.failed ? "Failed" : "Finished"} · ${clip(input.projectTitle, 60)}`,
        },
        sound: "default",
        category: PUSH_CATEGORY_AGENT,
        "thread-id": `thread:${input.threadId}`,
        "interruption-level": input.failed ? "active" : "passive",
      },
      cp: {
        cp: 1,
        kind: "agent-finished",
        environmentId: input.environmentId,
        deepLink: threadDeepLink(input.environmentId, input.threadId),
        threadId: input.threadId,
      },
    },
  };
}

export interface TaskReminderInput {
  readonly environmentId: string;
  readonly taskId: string;
  readonly title: string;
  /** "Overdue since yesterday", "Due 9:00 AM". */
  readonly detail: string;
  readonly threadId?: string;
}

export function taskReminderMessage(
  input: TaskReminderInput,
  action: { readonly url: string; readonly token: string } | null,
): PushMessage {
  return {
    kind: "task-reminder",
    collapseKey: apnsCollapseId(`task:${input.taskId}`),
    payload: {
      aps: {
        alert: {
          title: clip(input.title, ALERT_TITLE_MAX),
          body: clip(input.detail, ALERT_BODY_MAX),
        },
        sound: "default",
        category: PUSH_CATEGORY_TASK_REMINDER,
        "thread-id": "tasks",
        "interruption-level": "active",
      },
      cp: {
        cp: 1,
        kind: "task-reminder",
        environmentId: input.environmentId,
        taskId: input.taskId,
        ...(input.threadId === undefined
          ? {}
          : {
              threadId: input.threadId,
              deepLink: threadDeepLink(input.environmentId, input.threadId),
            }),
        ...(action === null ? {} : { actionUrl: action.url, actionToken: action.token }),
      },
    },
  };
}

export interface AssistantPingInput {
  readonly environmentId: string;
  /** Stable per ping, so a repeat replaces it. */
  readonly pingId: string;
  readonly title: string;
  readonly body: string;
  /** The Assistant thread a tap opens. */
  readonly threadId?: string;
}

/** The morning brief and other Assistant pings. A tap opens the Assistant. */
export function assistantPingMessage(input: AssistantPingInput): PushMessage {
  return {
    kind: "assistant",
    collapseKey: apnsCollapseId(`assistant:${input.pingId}`),
    payload: {
      aps: {
        alert: {
          title: clip(input.title, ALERT_TITLE_MAX),
          body: clip(input.body, ALERT_BODY_MAX),
        },
        sound: "default",
        category: PUSH_CATEGORY_ASSISTANT,
        "thread-id": "assistant",
        "interruption-level": "active",
      },
      cp: {
        cp: 1,
        kind: "assistant",
        environmentId: input.environmentId,
        ...(input.threadId === undefined
          ? {}
          : {
              threadId: input.threadId,
              deepLink: threadDeepLink(input.environmentId, input.threadId),
            }),
      },
    },
  };
}

/** "9:00 AM" from "09:00". */
export function formatReminderTime(hhmm: string): string {
  const [hours = 0, minutes = 0] = hhmm.split(":").map(Number);
  const suffix = hours < 12 ? "AM" : "PM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}
