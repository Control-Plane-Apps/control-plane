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

/**
 * Default minutes a working row may go without a running agent (or, with no
 * agents linked, without an update) before it reads as Stalled. The server
 * setting `statusStallMinutes` overrides it; 0 turns stall detection off.
 */
export const PROJECT_STATUS_STALL_MINUTES_DEFAULT = 15;

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
  /**
   * How the user answered: with the recommended answer's button (or the
   * same message from a notification), or a reply of their own. Absent on
   * answers recorded before this existed.
   */
  answeredWith: Schema.optional(Schema.Literals(["recommendation", "reply"])),
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

/**
 * Whether a workstream waits on the user: in `needs-you`, its question not yet
 * answered (an answered one waits on the coordinator), and not checked off.
 * Every "Needs you" surface (Status board, counts, badges, the Assistant's
 * list and overview tool) uses this one rule.
 */
export function isStatusNeedingUser(status: {
  readonly state: ProjectStatusState;
  readonly decision?: { readonly answeredAt?: string | undefined } | undefined;
  readonly dismissedAt?: string | undefined;
}): boolean {
  return (
    status.state === "needs-you" &&
    status.decision?.answeredAt === undefined &&
    status.dismissedAt === undefined
  );
}

/** Workstreams waiting on the user. A question they already answered waits on the coordinator. */
export function countStatusesNeedingUser(
  statuses:
    | ReadonlyArray<{
        readonly state: ProjectStatusState;
        readonly decision?: { readonly answeredAt?: string | undefined } | undefined;
        readonly dismissedAt?: string | undefined;
      }>
    | null
    | undefined,
): number {
  return (statuses ?? []).filter(isStatusNeedingUser).length;
}

/**
 * What the Status header's refresh icon sends the coordinator. A plain message,
 * not a `Re:` reply: it concerns the whole board, not one workstream.
 */
export const STATUS_REFRESH_PROMPT =
  "Refresh the Status board now. For each workstream, check its agents (cp_agent_list, cp_agent_read), update every row so it is true right now, and remove finished rows.";

/** How long the refresh icon waits for the board to change before it gives up and re-enables. */
export const STATUS_REFRESH_TIMEOUT_MS = 120_000;

/**
 * A fingerprint of the board's rows and when each last changed. The refresh
 * icon compares it before and after asking: any row updated, added, removed or
 * checked off means the coordinator answered.
 */
export function statusBoardSignature(
  statuses:
    | ReadonlyArray<{
        readonly id: string;
        readonly updatedAt: string;
        readonly dismissedAt?: string | undefined;
      }>
    | null
    | undefined,
): string {
  return (statuses ?? [])
    .map((status) => `${status.id}@${status.updatedAt}@${status.dismissedAt ?? ""}`)
    .sort()
    .join("|");
}

/**
 * Why the refresh icon is disabled, or null when the coordinator can be asked.
 * `phase` is the coordinator's server connection phase; null means unknown
 * (treated as reachable).
 */
export function statusRefreshBlockReason(phase: string | null): string | null {
  if (phase === null || phase === "connected") return null;
  return phase === "connecting" || phase === "reconnecting"
    ? "Reconnecting to the coordinator's machine"
    : "The coordinator's machine is offline";
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

export const STATUS_RECOMMENDATION_BODY_PREFIX = "Go with your recommendation:";

/**
 * The message "Go with recommendation" sends, naming the workstream and the
 * question's version. The Status panel and an iPhone notification's answer
 * button both send exactly this.
 */
export function recommendationReplyText(
  status: { readonly id: string; readonly title: string },
  decision: { readonly recommendation: string; readonly openedAt: string },
): string {
  return statusReplyText(
    status.title,
    `${STATUS_RECOMMENDATION_BODY_PREFIX} ${decision.recommendation}`,
    { statusId: status.id, openedAt: decision.openedAt },
  );
}

/** The user's one-tap answer as the button shows it: an action, never a done state. */
export function recommendedAnswerLabel(decision: { readonly answer?: string | undefined }): string {
  return decision.answer === undefined ? "Go with recommendation" : `Answer: ${decision.answer}`;
}

/**
 * What the row says once the user answered, or null while it is unanswered.
 * Only a real answer (the user tapped the recommendation or replied) shows one.
 */
export function answeredLabel(decision: {
  readonly answer?: string | undefined;
  readonly answeredAt?: string | undefined;
  readonly answeredWith?: "recommendation" | "reply" | undefined;
}): string | null {
  if (decision.answeredAt === undefined) return null;
  if (decision.answeredWith === "recommendation") {
    return decision.answer === undefined
      ? "You answered: went with the recommendation"
      : `You answered: ${decision.answer}`;
  }
  return "You replied";
}

// --- Stalled rows -----------------------------------------------------------

/**
 * The thread state stall detection reads, shared by server and clients. A
 * structural subset of `OrchestrationThreadShell` so this module keeps
 * importing only baseSchemas.
 */
export interface StatusAgentShell {
  readonly archivedAt: string | null;
  readonly settledAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly backgroundLiveness?: "working" | "monitoring" | null | undefined;
  readonly session: { readonly status: string; readonly updatedAt: string } | null;
  readonly latestTurn: {
    readonly requestedAt: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
}

/**
 * Whether an agent counts as on it: a turn starting or running, background
 * work still alive, or blocked on the user's approval or input (that surfaces
 * on its own). Idle, completed, failed, stopped, settled and archived agents
 * do not.
 */
export function isStatusAgentLive(shell: StatusAgentShell | null): boolean {
  if (shell === null || shell.archivedAt !== null) return false;
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return true;
  const session = shell.session?.status;
  if (session === "running" || session === "starting") return true;
  if (session === "error") return false;
  return shell.backgroundLiveness === "working" || shell.backgroundLiveness === "monitoring";
}

function latestMs(values: ReadonlyArray<string | null | undefined>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    if (value == null) continue;
    const at = Date.parse(value);
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/** When an agent last did anything this module can see, or null. */
export function statusAgentLastActiveMs(shell: StatusAgentShell | null): number | null {
  if (shell === null) return null;
  return latestMs([
    shell.latestTurn?.completedAt,
    shell.latestTurn?.startedAt,
    shell.latestTurn?.requestedAt,
    shell.session?.updatedAt,
    shell.settledAt,
    shell.archivedAt,
  ]);
}

/** "20m", "2h", "3d": a whole-unit duration, rounded down. */
export function formatStallDuration(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export type StatusStallKind = "agents-stopped" | "no-agents";

export interface StatusStall {
  readonly kind: StatusStallKind;
  /** When the clock started: the last agent activity or row update, whichever is later. */
  readonly sinceMs: number;
  /** "No agent running for 2h", "No update for 45m". */
  readonly reason: string;
}

/** The setting as minutes: a missing or invalid value falls back to the default. */
export function statusStallMinutesOf(setting: number | null | undefined): number {
  return typeof setting === "number" && Number.isFinite(setting) && setting >= 0
    ? setting
    : PROJECT_STATUS_STALL_MINUTES_DEFAULT;
}

/**
 * Whether a row claims work nobody is doing. A `working` row (or a `queued`
 * one with agents linked) is stalled once none of its agents has been live
 * for `stallMinutes`, counted from the later of their last activity and the
 * row's own last update. A `working` row with no agents linked counts from its
 * last update. A queued row with no agents is simply waiting, never stalled.
 * `agents` holds the linked threads' shells, null for any that is gone.
 */
export function statusStallOf(
  status: {
    readonly state: ProjectStatusState;
    readonly updatedAt: string;
    readonly agents?: ReadonlyArray<string> | undefined;
    readonly dismissedAt?: string | undefined;
  },
  agents: ReadonlyArray<StatusAgentShell | null>,
  nowMs: number,
  stallMinutes: number,
): StatusStall | null {
  if (stallMinutes <= 0 || status.dismissedAt !== undefined) return null;
  const linked = (status.agents?.length ?? 0) > 0;
  if (status.state !== "working" && !(status.state === "queued" && linked)) return null;
  const updatedMs = Date.parse(status.updatedAt);
  if (!Number.isFinite(updatedMs)) return null;
  if (linked && agents.some(isStatusAgentLive)) return null;
  const sinceMs = linked
    ? Math.max(updatedMs, ...agents.map((agent) => statusAgentLastActiveMs(agent) ?? 0))
    : updatedMs;
  const idleMs = nowMs - sinceMs;
  if (idleMs < stallMinutes * 60_000) return null;
  const duration = formatStallDuration(idleMs);
  return linked
    ? { kind: "agents-stopped", sinceMs, reason: `No agent running for ${duration}` }
    : { kind: "no-agents", sinceMs, reason: `No update for ${duration}` };
}

/** One nudge per stall: `cp-status:<projectId>:<statusId>:stalled:<sinceMs>`. */
export function statusStallMessageId(projectId: string, statusId: string, sinceMs: number): string {
  return `${STATUS_MESSAGE_PREFIX}${projectId}:${statusId}:stalled:${sinceMs}`;
}
