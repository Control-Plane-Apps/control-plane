import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Fork-owned. A Project's Status board: one record per workstream, written by
// the coordinator through `cp_status_set`. Imports only baseSchemas so
// assistants.ts can embed it without a cycle.

export const PROJECT_STATUS_LIMIT = 30;
export const PROJECT_STATUS_TITLE_MAX = 60;
/** Longest stored text for older records and expanded-only fields. */
export const PROJECT_STATUS_LINE_MAX = 240;
/**
 * Hard limits on new writes for what the collapsed row shows. Older records
 * written before these limits keep their longer text; the panel truncates it
 * visually on the collapsed row and shows it in full when expanded.
 */
export const PROJECT_STATUS_SUMMARY_MAX = 60;
export const PROJECT_STATUS_QUESTION_MAX = 80;
/** The recommended answer as a button label. */
export const PROJECT_STATUS_ANSWER_MAX = 24;
/** Expanded-only detail. */
export const PROJECT_STATUS_DETAIL_MAX = 600;
/** Expanded-only, one or two sentences on why the recommendation. */
export const PROJECT_STATUS_WHY_MAX = 240;
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
 * version: any change to the question, recommendation, answer label or
 * deadline restamps it, which drops the user's opt-in and owes a fresh
 * deadline handling.
 */
export const ProjectStatusDecision = Schema.Struct({
  question: TrimmedNonEmptyString,
  /** The full recommended action; what "go with the recommendation" sends. */
  recommendation: TrimmedNonEmptyString,
  /**
   * The recommendation as a short button label, such as "Amend first". Absent
   * on records written before labels existed; the panel then shows a generic
   * label and the full recommendation in the expanded detail.
   */
  answer: Schema.optional(TrimmedNonEmptyString),
  /** One or two sentences on why, shown when the row is expanded. */
  why: Schema.optional(TrimmedNonEmptyString),
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
  /**
   * The user checked this finished workstream off; the panel hides it. Only
   * the user's `project.status.dismiss` sets it, only on a `done` record, and
   * any coordinator write that moves the record off `done` clears it.
   */
  dismissedAt: Schema.optional(IsoDateTime),
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
    answer: Schema.optional(TrimmedNonEmptyString),
    /** Empty string removes it. */
    why: Schema.optional(Schema.String),
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

/** Records the panel shows: everything except finished work the user checked off. */
export function visibleProjectStatuses<T extends { readonly dismissedAt?: string | undefined }>(
  statuses: ReadonlyArray<T>,
): T[] {
  return statuses.filter((status) => status.dismissedAt === undefined);
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

/** Which workstream, and which version of its question, a reply answers. */
export interface StatusReplyRef {
  readonly statusId: string;
  /** The decision's `openedAt` the user saw; absent for a row without a question. */
  readonly openedAt?: string | undefined;
}

/**
 * A reply to a workstream as the coordinator reads it: a readable `Re: <title>`
 * header carrying the stable workstream id and question version, then the text.
 * `Re: Payouts [status:payouts@1793188800000]`.
 */
export function statusReplyText(title: string, body: string, ref?: StatusReplyRef): string {
  const tag =
    ref === undefined
      ? ""
      : ` [status:${ref.statusId}${ref.openedAt === undefined ? "" : `@${Date.parse(ref.openedAt)}`}]`;
  return `Re: ${title}${tag}\n\n${body}`;
}

export interface ParsedStatusReply {
  readonly title: string;
  readonly body: string;
  readonly statusId?: string;
  /** `Date.parse` of the decision's `openedAt` the user replied to. */
  readonly revision?: number;
}

/**
 * Splits a composer `Re:` header off a coordinator message. Tolerates the
 * `Ultrathink:` line a Claude effort setting puts in front of the text, and a
 * header without the id (typed by hand, or from an older client).
 */
export function parseStatusReply(text: string): ParsedStatusReply | null {
  const match =
    /^(?:Ultrathink:[ \t]*\n)?Re: ([^\n]{1,80}?)(?: \[status:([a-z0-9-]{1,40})(?:@(\d{1,16}))?\])?\n\n/.exec(
      text,
    );
  if (match === null) return null;
  return {
    title: match[1]!.trim(),
    body: text.slice(match[0].length),
    ...(match[2] !== undefined ? { statusId: match[2] } : {}),
    ...(match[3] !== undefined ? { revision: Number(match[3]) } : {}),
  };
}
