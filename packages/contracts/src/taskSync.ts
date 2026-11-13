import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Fork-owned. Task Sync: the Mac server signs in to the Control Plane account
// and keeps tasks in sync with the cloud task store, so the list also works
// from the phone while the Mac sleeps. Every string here can reach the user;
// none may name the underlying service.

export const TaskSyncState = Schema.Literals([
  /** The server has no Task Sync client key (development builds). */
  "unavailable",
  "signed-out",
  "syncing",
  "synced",
  /** Signed in, but the account's Task Sync subscription is not active. */
  "inactive",
  /** The last attempt failed; it retries on its own. */
  "error",
]);
export type TaskSyncState = typeof TaskSyncState.Type;

export const TaskSyncSubscription = Schema.Struct({
  /** `grace`: a payment failed, sync keeps running for a few days. */
  status: Schema.Literals(["active", "grace", "inactive"]),
  currentPeriodEnd: Schema.optional(IsoDateTime),
  cancelAtPeriodEnd: Schema.optional(Schema.Boolean),
  /** A billing portal exists for this account (it has subscribed before). */
  canManage: Schema.optional(Schema.Boolean),
});
export type TaskSyncSubscription = typeof TaskSyncSubscription.Type;

export const TaskSyncStatus = Schema.Struct({
  state: TaskSyncState,
  account: Schema.optional(Schema.Struct({ email: TrimmedNonEmptyString })),
  subscription: Schema.optional(TaskSyncSubscription),
  lastSyncedAt: Schema.optional(IsoDateTime),
  /** Local edits waiting to reach the cloud. */
  pendingChanges: Schema.Number,
  /** User-facing reason for `error`. */
  error: Schema.optional(Schema.String),
  /** 0-6, Sunday first. The account's week start, which periods follow. */
  weekStartsOn: Schema.Number,
});
export type TaskSyncStatus = typeof TaskSyncStatus.Type;

export const TaskSyncRequestCodeInput = Schema.Struct({ email: TrimmedNonEmptyString });
export type TaskSyncRequestCodeInput = typeof TaskSyncRequestCodeInput.Type;

export const TaskSyncVerifyInput = Schema.Struct({
  email: TrimmedNonEmptyString,
  code: TrimmedNonEmptyString,
});
export type TaskSyncVerifyInput = typeof TaskSyncVerifyInput.Type;

export const TaskSyncUrlResult = Schema.Struct({ url: TrimmedNonEmptyString });
export type TaskSyncUrlResult = typeof TaskSyncUrlResult.Type;

export const TaskSyncErrorReason = Schema.Literals([
  "unavailable",
  "signed-out",
  "invalid-email",
  "invalid-code",
  "rate-limited",
  "network",
  "inactive",
  "server",
]);
export type TaskSyncErrorReason = typeof TaskSyncErrorReason.Type;

export class TaskSyncError extends Schema.TaggedError<TaskSyncError>()("TaskSyncError", {
  reason: TaskSyncErrorReason,
}) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "Task Sync isn't available in this build of Control Plane.";
      case "signed-out":
        return "Sign in to your Control Plane account first.";
      case "invalid-email":
        return "Enter a valid email address.";
      case "invalid-code":
        return "That code didn't work. Check it, or send a new one.";
      case "rate-limited":
        return "Too many attempts. Wait a few minutes and try again.";
      case "network":
        return "Couldn't reach Control Plane's servers. Check your connection and try again.";
      case "inactive":
        return "Task Sync isn't active on this account.";
      case "server":
        return "Something went wrong on our side. Try again in a moment.";
    }
  }
}
