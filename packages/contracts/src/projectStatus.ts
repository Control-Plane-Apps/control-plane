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
 * A question for the user on the workstream it blocks. `openedAt` names this
 * version of the question: rewording it keeps the stamp, asking a different
 * question or moving the deadline restamps it, and a reminder is owed once
 * per stamp.
 */
export const ProjectStatusDecision = Schema.Struct({
  question: TrimmedNonEmptyString,
  recommendation: TrimmedNonEmptyString,
  /** What the coordinator says it will do if the deadline passes without a reply. */
  ifNoReply: Schema.optional(TrimmedNonEmptyString),
  deadline: Schema.optional(IsoDateTime),
  openedAt: IsoDateTime,
  /** Set once the server has reminded the coordinator that the deadline passed. */
  remindedAt: Schema.optional(IsoDateTime),
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
    ifNoReply: Schema.optional(Schema.String),
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

/** Records waiting on the user, first. Stable otherwise. */
export function sortProjectStatuses<T extends { readonly state: ProjectStatusState }>(
  statuses: ReadonlyArray<T>,
): T[] {
  const rank = (state: ProjectStatusState) =>
    state === "needs-you" ? 0 : state === "working" ? 1 : state === "queued" ? 2 : 3;
  return statuses
    .map((status, index) => ({ status, index }))
    .toSorted((a, b) => rank(a.status.state) - rank(b.status.state) || a.index - b.index)
    .map(({ status }) => status);
}

export function countStatusesNeedingUser(
  statuses: ReadonlyArray<{ readonly state: ProjectStatusState }> | null | undefined,
): number {
  return (statuses ?? []).filter((status) => status.state === "needs-you").length;
}

/** A reply to a workstream as the coordinator reads it: the composer's Re: tag, then the text. */
export function statusReplyText(title: string, body: string): string {
  return `Re: ${title}\n\n${body}`;
}

/** Splits a composer `Re: <title>` first line off a coordinator message. */
export function parseStatusReply(
  text: string,
): { readonly title: string; readonly body: string } | null {
  const match = /^Re: ([^\n]{1,80})\n\n/.exec(text);
  if (match === null) return null;
  return { title: match[1]!.trim(), body: text.slice(match[0].length) };
}
