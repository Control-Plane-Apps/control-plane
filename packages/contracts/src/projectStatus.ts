import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Fork-owned. A Project's Status board: one record per workstream, written by
// the coordinator through `cp_status_set`. Imports only baseSchemas so
// assistants.ts can embed it without a cycle.

export const PROJECT_STATUS_LIMIT = 30;
export const PROJECT_STATUS_TITLE_MAX = 60;
export const PROJECT_STATUS_LINE_MAX = 240;
export const PROJECT_STATUS_AGENTS_MAX = 8;
/** A record the coordinator has not touched for this long reads as stale. */
export const PROJECT_STATUS_STALE_MS = 24 * 60 * 60 * 1000;

/** Reminder messages: `cp-status:<projectId>:<statusId>:<openedAtMs>`. */
export const STATUS_MESSAGE_PREFIX = "cp-status:";

export const ProjectStatusId = Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,40}$/));
export type ProjectStatusId = typeof ProjectStatusId.Type;

export const ProjectStatusState = Schema.Literals(["needs-you", "working", "done", "queued"]);
export type ProjectStatusState = typeof ProjectStatusState.Type;

/**
 * How a passed deadline was handled. `reminded` (the default) tells the
 * coordinator and keeps waiting on the user. `accepted` sent the
 * recommendation as the answer, which only the user's own opt-in for that
 * exact version allows.
 */
export const ProjectStatusDeadlineOutcome = Schema.Literals(["reminded", "accepted"]);
export type ProjectStatusDeadlineOutcome = typeof ProjectStatusDeadlineOutcome.Type;

/**
 * A question for the user on the workstream it blocks. `openedAt` names this
 * version: any change to the question, recommendation or deadline restamps
 * it, which drops the user's opt-in and owes a fresh deadline handling.
 */
export const ProjectStatusDecision = Schema.Struct({
  question: TrimmedNonEmptyString,
  recommendation: TrimmedNonEmptyString,
  deadline: Schema.optional(IsoDateTime),
  openedAt: IsoDateTime,
  /**
   * The user's opt-in to go with the recommendation if the deadline passes
   * without a reply. Only the user's `project.status.automate` sets it, and it
   * counts only while its `openedAt` matches the decision's.
   */
  autoAccept: Schema.optional(Schema.Struct({ openedAt: IsoDateTime, enabledAt: IsoDateTime })),
  /** The user replied to this workstream; its deadline no longer fires. */
  answeredAt: Schema.optional(IsoDateTime),
  /** Set once the deadline passed and was handled; at most once per version. */
  deadlineHandled: Schema.optional(
    Schema.Struct({ at: IsoDateTime, outcome: ProjectStatusDeadlineOutcome }),
  ),
});
export type ProjectStatusDecision = typeof ProjectStatusDecision.Type;

export const ProjectStatus = Schema.Struct({
  id: ProjectStatusId,
  title: TrimmedNonEmptyString,
  /** `needs-you` whenever `decision` is present. */
  state: ProjectStatusState,
  /** Where it stands. */
  summary: TrimmedNonEmptyString,
  /** Optional second line: what is still moving, or what is not. */
  detail: Schema.optional(TrimmedNonEmptyString),
  /** Agent threads on this workstream; the UI shows their live state. */
  agents: Schema.optional(Schema.Array(ThreadId)),
  decision: Schema.optional(ProjectStatusDecision),
  updatedAt: IsoDateTime,
});
export type ProjectStatus = typeof ProjectStatus.Type;

/**
 * One coordinator write to one record. Omitted fields keep their stored
 * value; `clearDecision` drops the question once the user has answered.
 */
export const ProjectStatusChange = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("upsert"),
    id: ProjectStatusId,
    title: Schema.optional(TrimmedNonEmptyString),
    state: Schema.optional(ProjectStatusState),
    summary: Schema.optional(TrimmedNonEmptyString),
    /** Empty string removes the second line. */
    detail: Schema.optional(Schema.String),
    agents: Schema.optional(Schema.Array(ThreadId)),
    question: Schema.optional(TrimmedNonEmptyString),
    recommendation: Schema.optional(TrimmedNonEmptyString),
    deadline: Schema.optional(Schema.NullOr(IsoDateTime)),
    clearDecision: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ kind: Schema.Literal("remove"), id: ProjectStatusId }),
]);
export type ProjectStatusChange = typeof ProjectStatusChange.Type;

export function isStatusMessageId(id: string): boolean {
  return id.startsWith(STATUS_MESSAGE_PREFIX);
}

export function statusReminderMessageId(
  projectId: string,
  statusId: string,
  openedAt: string,
): string {
  return `${STATUS_MESSAGE_PREFIX}${projectId}:${statusId}:${Date.parse(openedAt)}`;
}

/** Whether the user's opt-in applies to the decision as it stands now. */
export function isAutoAcceptArmed(decision: ProjectStatusDecision | undefined): boolean {
  return (
    decision?.deadline !== undefined &&
    decision.autoAccept?.openedAt === decision.openedAt &&
    decision.answeredAt === undefined &&
    decision.deadlineHandled === undefined
  );
}

/** Records waiting on the user, first. Stable otherwise. */
export function sortProjectStatuses<T extends { readonly state: ProjectStatusState }>(
  statuses: ReadonlyArray<T>,
): T[] {
  const rank = (state: ProjectStatusState) =>
    state === "needs-you" ? 0 : state === "working" ? 1 : state === "queued" ? 2 : 3;
  return statuses
    .map((status, index) => ({ status, index }))
    .sort((a, b) => rank(a.status.state) - rank(b.status.state) || a.index - b.index)
    .map(({ status }) => status);
}

/** Workstreams waiting on the user. A question they already answered waits on the coordinator. */
export function countStatusesNeedingUser(
  statuses:
    | ReadonlyArray<{
        readonly state: ProjectStatusState;
        readonly decision?: { readonly answeredAt?: string | undefined } | undefined;
      }>
    | null
    | undefined,
): number {
  return (statuses ?? []).filter(
    (status) => status.state === "needs-you" && status.decision?.answeredAt === undefined,
  ).length;
}

/** A reply to a workstream as the coordinator reads it: the composer's Re: tag, then the text. */
export function statusReplyText(title: string, body: string): string {
  return `Re: ${title}\n\n${body}`;
}

/**
 * Splits a composer `Re: <title>` header off a coordinator message. Tolerates
 * the `Ultrathink:` line a Claude effort setting puts in front of the text.
 */
export function parseStatusReply(
  text: string,
): { readonly title: string; readonly body: string } | null {
  const match = /^(?:Ultrathink:[ \t]*\n)?Re: ([^\n]{1,80})\n\n/.exec(text);
  if (match === null) return null;
  return { title: match[1]!.trim(), body: text.slice(match[0].length) };
}
