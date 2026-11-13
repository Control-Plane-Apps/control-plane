import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// Fork-owned. iPhone lock-screen notifications sent by the Mac server straight
// to APNs. The phone registers its APNs token over its tailnet connection, and
// answers from a notification come back to the Mac with a server-minted action
// token that names one exact action (one question version, one task).

/** `POST`: register or update this phone. Session bearer with operate scope. */
export const PUSH_DEVICES_ROUTE_PATH = "/api/push/devices";
/** `POST`: run one notification action. `Authorization: Bearer <action token>`. */
export const PUSH_ACTION_ROUTE_PATH = "/api/push/action";

/** Which notifications the phone wants. Mirrors Settings > General > Notifications. */
export const PushNotificationLevel = Schema.Literals(["all", "needs-you", "off"]);
export type PushNotificationLevel = typeof PushNotificationLevel.Type;
export const DEFAULT_PUSH_NOTIFICATION_LEVEL: PushNotificationLevel = "needs-you";

export const PushApsEnvironment = Schema.Literals(["sandbox", "production"]);
export type PushApsEnvironment = typeof PushApsEnvironment.Type;

export const PushDeviceRegistration = Schema.Struct({
  /** Stable per install. */
  deviceId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,128}$/)),
  /** Hex APNs device token. */
  apnsToken: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{32,200}$/)),
  apsEnvironment: PushApsEnvironment,
  bundleId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9.-]{1,155}$/)),
  /**
   * This server's base URL as the phone reaches it (tailnet or LAN). Answers
   * from the lock screen post back here.
   */
  serverUrl: Schema.String.check(Schema.isPattern(/^https?:\/\/\S{1,500}$/)),
  level: PushNotificationLevel,
  label: Schema.optional(TrimmedNonEmptyString),
  /** `false` unregisters. */
  enabled: Schema.optional(Schema.Boolean),
});
export type PushDeviceRegistration = typeof PushDeviceRegistration.Type;

/** Notification categories. The status question category is per notification (see below). */
export const PUSH_CATEGORY_STATUS_QUESTION = "cp.status-question";
export const PUSH_CATEGORY_TASK_REMINDER = "cp.task-reminder";
export const PUSH_CATEGORY_ASSISTANT = "cp.assistant";
export const PUSH_CATEGORY_AGENT = "cp.agent";

export const PUSH_ACTION_ANSWER = "cp.answer";
export const PUSH_ACTION_REPLY = "cp.reply";
export const PUSH_ACTION_SNOOZE = "cp.snooze";
export const PUSH_ACTION_COMPLETE = "cp.complete";

/** Snooze holds a notification back this long, then shows it again. */
export const PUSH_SNOOZE_SECONDS = 60 * 60;

export const PushNotificationKind = Schema.Literals([
  "status-question",
  "agent-finished",
  "task-reminder",
  "assistant",
]);
export type PushNotificationKind = typeof PushNotificationKind.Type;

/**
 * The custom keys of every Control Plane push, beside `aps`. The phone reads
 * them to route a tap and run an action; the native action handler reads
 * `actionUrl` and `actionToken` without the JS runtime.
 */
export interface PushNotificationData {
  readonly cp: 1;
  readonly kind: PushNotificationKind;
  readonly environmentId: string;
  /** `/threads/<environmentId>/<threadId>`: where a tap opens. */
  readonly deepLink?: string;
  readonly threadId?: string;
  readonly projectId?: string;
  readonly statusId?: string;
  readonly statusTitle?: string;
  /** The decision version the notification shows. */
  readonly openedAt?: string;
  /** Label for the answer button: the coordinator's short answer. */
  readonly answerLabel?: string;
  readonly taskId?: string;
  /** Where the native handler posts an action. */
  readonly actionUrl?: string;
  /** Scoped, signed token for the action buttons on this notification. */
  readonly actionToken?: string;
}

/** What a notification action asks the server to do. */
export const PushActionRequest = Schema.Struct({
  action: Schema.Literals(["answer", "complete"]),
});
export type PushActionRequest = typeof PushActionRequest.Type;

/** Why the server refused an action, for the follow-up notification. */
export const PushActionRefusal = Schema.Literals([
  "outdated",
  "answered",
  "not-found",
  "unsupported",
]);
export type PushActionRefusal = typeof PushActionRefusal.Type;

/**
 * Message id of an answer sent from a notification:
 * `cp-status:<projectId>:<statusId>:<openedAtMs>:answer`. It lives in the
 * Status message family so it is delivered like a deadline message, and the
 * decider refuses it unless it answers the question version it names.
 */
export const STATUS_ANSWER_MESSAGE_SUFFIX = ":answer";

export function statusAnswerMessageId(
  projectId: string,
  statusId: string,
  openedAt: string,
): string {
  return `cp-status:${projectId}:${statusId}:${Date.parse(openedAt)}${STATUS_ANSWER_MESSAGE_SUFFIX}`;
}

export function isStatusAnswerMessageId(id: string): boolean {
  return id.startsWith("cp-status:") && id.endsWith(STATUS_ANSWER_MESSAGE_SUFFIX);
}
