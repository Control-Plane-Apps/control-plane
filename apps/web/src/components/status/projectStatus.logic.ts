import { resolveSidebarThreadStatus } from "@t3tools/client-runtime/state/thread-status";
import {
  PROJECT_STATUS_STALE_MS,
  STATUS_RECOMMENDATION_BODY_PREFIX,
  isAutoAcceptArmed,
  parseStatusReply,
  recommendedAnswerLabel,
  sortProjectStatuses,
  statusStallOf,
  visibleProjectStatuses,
  type StatusAgentShell,
  type StatusStall,
  type OrchestrationThreadShell,
  type ProjectStatus,
  type ProjectStatusDecision,
} from "@t3tools/contracts";

import { formatElapsedDurationLabel } from "../../timestampFormat";

// Pure presentation for the coordinator's Status panel and composer strip.

export type StatusGroup = "needs-you" | "in-progress" | "queued" | "done";

export const STATUS_GROUP_LABEL: Record<StatusGroup, string> = {
  "needs-you": "Needs you",
  "in-progress": "In progress",
  queued: "Queued",
  done: "Done",
};

const STATUS_GROUP_ORDER: ReadonlyArray<StatusGroup> = [
  "needs-you",
  "in-progress",
  "queued",
  "done",
];

/**
 * Where a row reads truthfully: a question the user already answered waits on
 * the coordinator, so it sits with the work in progress until it is cleared.
 */
export function statusGroupOf(status: Pick<ProjectStatus, "state" | "decision">): StatusGroup {
  switch (status.state) {
    case "needs-you":
      return status.decision?.answeredAt !== undefined ? "in-progress" : "needs-you";
    case "working":
      return "in-progress";
    case "queued":
      return "queued";
    case "done":
      return "done";
  }
}

/**
 * Non-empty groups in panel order, each keeping the coordinator's order.
 * Finished rows the user checked off are left out. Stalled rows (by id) sit
 * at the top of In progress, whatever state they claim, so they are seen.
 */
export function groupProjectStatuses<
  T extends Pick<ProjectStatus, "id" | "state" | "decision" | "dismissedAt">,
>(
  statuses: ReadonlyArray<T>,
  stalledIds: ReadonlySet<string> = new Set(),
): ReadonlyArray<{ readonly group: StatusGroup; readonly statuses: ReadonlyArray<T> }> {
  const sorted = sortProjectStatuses(visibleProjectStatuses(statuses));
  const groupOf = (status: T) =>
    stalledIds.has(status.id) ? "in-progress" : statusGroupOf(status);
  return STATUS_GROUP_ORDER.flatMap((group) => {
    const members = sorted.filter((status) => groupOf(status) === group);
    const ordered =
      group === "in-progress"
        ? [
            ...members.filter((status) => stalledIds.has(status.id)),
            ...members.filter((status) => !stalledIds.has(status.id)),
          ]
        : members;
    return ordered.length === 0 ? [] : [{ group, statuses: ordered }];
  });
}

/**
 * A row's stall, from its linked agents' live shells (absent ones count as
 * gone). Null when it is not stalled or stall detection is off.
 */
export function statusStallFor(
  status: Pick<ProjectStatus, "state" | "updatedAt" | "agents" | "dismissedAt">,
  shellsById: ReadonlyMap<string, StatusAgentShell>,
  nowMs: number,
  stallMinutes: number,
): StatusStall | null {
  return statusStallOf(
    status,
    (status.agents ?? []).map((id) => shellsById.get(id) ?? null),
    nowMs,
    stallMinutes,
  );
}

/**
 * The primary button for an unanswered question: an action ("Answer: Pilot
 * with 5"), never a done state, so it cannot read as already answered.
 */
export function recommendationButtonLabel(decision: Pick<ProjectStatusDecision, "answer">): string {
  return recommendedAnswerLabel(decision);
}

/** "now", "12m", "3h", "2d": the collapsed row's freshness. */
export function formatStatusAgeShort(updatedAt: string, nowMs: number): string {
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor((nowMs - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The full recommendation belongs in the expanded row only when the button
 * does not already say it: no short answer, or one that differs from it.
 */
export function showsFullRecommendation(
  decision: Pick<ProjectStatusDecision, "answer" | "recommendation">,
): boolean {
  return decision.answer === undefined || decision.answer.trim() !== decision.recommendation.trim();
}

/** "just now", "12m ago", "3h ago", "2d ago". */
export function formatStatusAge(updatedAt: string, nowMs: number): string {
  const label = formatElapsedDurationLabel(updatedAt, nowMs);
  if (label === "" || label === "just now" || label.endsWith("s")) return "just now";
  return `${label} ago`;
}

export function isStatusStale(updatedAt: string, nowMs: number): boolean {
  const at = Date.parse(updatedAt);
  return Number.isFinite(at) && nowMs - at >= PROJECT_STATUS_STALE_MS;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * A deadline as a reply-by hint, in local time: "3:00 PM" today, "tomorrow",
 * a weekday ("Thu") within the week, else a short date ("Nov 20").
 */
export function formatDeadlineShort(deadline: string, nowMs: number, locale?: string): string {
  const date = new Date(deadline);
  if (Number.isNaN(date.getTime())) return "";
  const dayDiff = Math.round((startOfDay(date) - startOfDay(new Date(nowMs))) / 86_400_000);
  if (dayDiff === 0) {
    return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);
  }
  if (dayDiff === 1) return "tomorrow";
  if (dayDiff > 1 && dayDiff < 7) {
    return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date);
  }
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
}

export function isDeadlineOverdue(deadline: string | undefined, nowMs: number): boolean {
  if (deadline === undefined) return false;
  const at = Date.parse(deadline);
  return Number.isFinite(at) && at <= nowMs;
}

export type DecisionDeadlineTone = "pending" | "overdue" | "handled";

/**
 * What a decision's deadline will do, for the expanded row's meta line, or
 * null when it has none or the user already replied. Silence only ever
 * reminds, unless the user opted in for this exact version of the decision.
 */
export function describeDecisionDeadline(
  decision: ProjectStatusDecision,
  nowMs: number,
  locale?: string,
): { readonly text: string; readonly tone: DecisionDeadlineTone } | null {
  const { deadline } = decision;
  if (deadline === undefined || decision.answeredAt !== undefined) return null;
  if (decision.deadlineHandled?.outcome === "accepted") {
    return { text: "recommendation sent at the deadline", tone: "handled" };
  }
  // Armed and past due: the server's sweep is about to send it.
  if (
    decision.deadlineHandled === undefined &&
    isDeadlineOverdue(deadline, nowMs) &&
    isAutoAcceptArmed(decision)
  ) {
    return { text: "sending the recommendation now", tone: "handled" };
  }
  if (decision.deadlineHandled?.outcome === "reminded" || isDeadlineOverdue(deadline, nowMs)) {
    return { text: "deadline passed, still waiting on you", tone: "overdue" };
  }
  const when = formatDeadlineShort(deadline, nowMs, locale);
  return {
    text: isAutoAcceptArmed(decision)
      ? `goes ahead ${when} if no reply`
      : `reminds you ${when} if no reply`,
    tone: "pending",
  };
}

/** Whether the user can still opt in (or out) of going with the recommendation at the deadline. */
export function canToggleAutoAccept(
  decision: Pick<ProjectStatusDecision, "deadline" | "answeredAt" | "deadlineHandled">,
  nowMs: number,
): boolean {
  return (
    decision.deadline !== undefined &&
    decision.answeredAt === undefined &&
    decision.deadlineHandled === undefined &&
    !isDeadlineOverdue(decision.deadline, nowMs)
  );
}

export type LiveAgentTone = "working" | "attention" | "idle";

type LiveAgentShell = Pick<
  OrchestrationThreadShell,
  | "title"
  | "archivedAt"
  | "settledAt"
  | "latestTurn"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "session"
  | "backgroundLiveness"
>;

/**
 * What an agent the coordinator tied to a workstream is doing right now, from
 * the app's own thread state. Null when the thread is gone or archived.
 */
export function describeLiveAgent(
  shell: LiveAgentShell | null,
  nowMs: number,
): { readonly label: string; readonly tone: LiveAgentTone } | null {
  if (shell === null || shell.archivedAt !== null) return null;
  const status = resolveSidebarThreadStatus(shell);
  switch (status) {
    case "working": {
      const since = shell.latestTurn?.startedAt ?? shell.latestTurn?.requestedAt ?? null;
      const elapsed = since === null ? "" : formatElapsedDurationLabel(since, nowMs);
      const running = elapsed === "" || elapsed === "just now" ? "working" : `working ${elapsed}`;
      return { label: `${shell.title} · ${running}`, tone: "working" };
    }
    case "monitoring":
      return { label: `${shell.title} · monitoring`, tone: "working" };
    case "approval":
      return { label: `${shell.title} · needs approval`, tone: "attention" };
    case "input":
      return { label: `${shell.title} · needs input`, tone: "attention" };
    case "failed":
      return { label: `${shell.title} · failed`, tone: "attention" };
    case "ready":
      return {
        label: `${shell.title} · ${shell.settledAt !== null ? "settled" : "idle"}`,
        tone: "idle",
      };
  }
}

export const ASK_FOR_UPDATE_PROMPT = "Any update?";

// Shared with the server, which sends the same answer from an iPhone notification.
export { recommendationReplyText } from "@t3tools/contracts";

/** `<statusId>@<revision>`: one version of one workstream's question. */
export function recommendationKey(
  status: Pick<ProjectStatus, "id">,
  decision: Pick<ProjectStatusDecision, "openedAt">,
): string {
  return `${status.id}@${Date.parse(decision.openedAt)}`;
}

/** The key of a "Go with recommendation" message, or null for any other text. */
export function recommendationKeyOfText(text: string): string | null {
  const reply = parseStatusReply(text);
  if (
    reply === null ||
    reply.statusId === undefined ||
    reply.revision === undefined ||
    !reply.body.startsWith(STATUS_RECOMMENDATION_BODY_PREFIX)
  ) {
    return null;
  }
  return `${reply.statusId}@${reply.revision}`;
}

/** Keys of the "Go with recommendation" messages among a thread's user messages. */
export function sentRecommendationKeys(
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    const key = recommendationKeyOfText(message.text);
    if (key !== null) keys.add(key);
  }
  return keys;
}

/** Identity of one version of a decision, for toggles in flight. */
export function decisionKey(
  status: Pick<ProjectStatus, "id">,
  decision: Pick<ProjectStatusDecision, "openedAt">,
): string {
  return `${status.id}@${decision.openedAt}`;
}

/**
 * Whether this decision's "Go with recommendation" is waiting in the composer
 * queue. Matched by workstream id and question version, so a removed,
 * restored or failed message frees the button again.
 */
export function isRecommendationQueued(
  queue: ReadonlyArray<{ readonly prompt: string }>,
  status: Pick<ProjectStatus, "id" | "decision">,
): boolean {
  const decision = status.decision;
  if (decision === undefined || decision.answeredAt !== undefined) return false;
  const key = recommendationKey(status, decision);
  return queue.some((message) => recommendationKeyOfText(message.prompt) === key);
}

/**
 * Whether "Go with recommendation" is on its way for the decision as it
 * stands: queued, or already in the thread while the server has not marked
 * the decision answered yet.
 */
export function isRecommendationPending(input: {
  readonly status: Pick<ProjectStatus, "id" | "decision">;
  readonly queue: ReadonlyArray<{ readonly prompt: string }>;
  readonly sentKeys: ReadonlySet<string>;
}): boolean {
  const decision = input.status.decision;
  if (decision === undefined || decision.answeredAt !== undefined) return false;
  return (
    isRecommendationQueued(input.queue, input.status) ||
    input.sentKeys.has(recommendationKey(input.status, decision))
  );
}

/**
 * Where a row offers Reply. Every row can be replied to: beside its open
 * question (`question`), beside the answered question it waits on
 * (`answered`), or as a compact button in its header (`header`) when no
 * question shows.
 */
export type StatusReplyPlacement = "question" | "answered" | "header";

export function statusReplyPlacement(
  status: Pick<ProjectStatus, "state" | "decision">,
  group: StatusGroup = statusGroupOf(status),
): StatusReplyPlacement {
  const decision = status.decision;
  if (decision?.answeredAt !== undefined) return "answered";
  if (decision !== undefined && group === "needs-you") return "question";
  return "header";
}

/**
 * The row a header Reply tags: the workstream alone, never a question
 * version, so it can only name the workstream and never answer a decision.
 */
export function headerReplyTarget<T extends { readonly decision?: unknown }>(
  status: T,
): Omit<T, "decision"> {
  const { decision: _hidden, ...rest } = status;
  return rest;
}
