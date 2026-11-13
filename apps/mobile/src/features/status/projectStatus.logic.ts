import { resolveSidebarThreadStatus } from "@t3tools/client-runtime/state/thread-status";
import {
  PROJECT_STATUS_STALE_MS,
  STATUS_RECOMMENDATION_BODY_PREFIX,
  isAutoAcceptArmed,
  parseStatusReply,
  sortProjectStatuses,
  statusReplyText,
  visibleProjectStatuses,
  type OrchestrationThreadShell,
  type ProjectStatus,
  type ProjectStatusDecision,
} from "@t3tools/contracts";

// Fork-owned. Pure presentation for the coordinator's Status screen on mobile.
// Mirrors apps/web/src/components/status/projectStatus.logic.ts so both
// clients group, label and reply the same way.

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
 * A question the user already answered waits on the coordinator, so it sits
 * with the work in progress until it is cleared.
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

/** Non-empty groups in screen order. Checked-off finished rows are left out. */
export function groupProjectStatuses<
  T extends Pick<ProjectStatus, "state" | "decision" | "dismissedAt">,
>(
  statuses: ReadonlyArray<T>,
): ReadonlyArray<{ readonly group: StatusGroup; readonly statuses: ReadonlyArray<T> }> {
  const sorted = sortProjectStatuses(visibleProjectStatuses(statuses));
  return STATUS_GROUP_ORDER.flatMap((group) => {
    const members = sorted.filter((status) => statusGroupOf(status) === group);
    return members.length === 0 ? [] : [{ group, statuses: members }];
  });
}

export function recommendationButtonLabel(decision: Pick<ProjectStatusDecision, "answer">): string {
  return decision.answer ?? "Go with recommendation";
}

export function showsFullRecommendation(
  decision: Pick<ProjectStatusDecision, "answer" | "recommendation">,
): boolean {
  return decision.answer === undefined || decision.answer.trim() !== decision.recommendation.trim();
}

/** "just now", "8m", "3h", "2d": time since an instant, no suffix. */
export function formatElapsed(isoDate: string, nowMs: number): string {
  const at = Date.parse(isoDate);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.floor((nowMs - at) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** "just now", "12m ago", "3h ago", "2d ago". */
export function formatStatusAge(updatedAt: string, nowMs: number): string {
  const label = formatElapsed(updatedAt, nowMs);
  return label === "" || label === "just now" ? "just now" : `${label} ago`;
}

export function isStatusStale(updatedAt: string, nowMs: number): boolean {
  const at = Date.parse(updatedAt);
  return Number.isFinite(at) && nowMs - at >= PROJECT_STATUS_STALE_MS;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "4 PM" or "4:30 PM": a whole hour drops its minutes. */
function formatClock(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    ...(date.getMinutes() === 0 ? {} : { minute: "2-digit" }),
  }).format(date);
}

/**
 * A deadline as a reply-by hint, in local time: "4 PM" today, "tomorrow",
 * a weekday ("Thu") within the week, else a short date ("Nov 20").
 */
export function formatDeadlineShort(deadline: string, nowMs: number, locale?: string): string {
  const date = new Date(deadline);
  if (Number.isNaN(date.getTime())) return "";
  const dayDiff = Math.round((startOfDay(date) - startOfDay(new Date(nowMs))) / 86_400_000);
  if (dayDiff === 0) return formatClock(date, locale);
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
 * The expanded row's deadline note, or null when there is none or the user
 * already replied. Silence only reminds unless the user opted in.
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
  return { text: `Decide by ${formatDeadlineShort(deadline, nowMs, locale)}`, tone: "pending" };
}

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

/** What an agent on a workstream is doing now. Null when it is gone or archived. */
export function describeLiveAgent(
  shell: LiveAgentShell | null,
): { readonly label: string; readonly tone: LiveAgentTone } | null {
  if (shell === null || shell.archivedAt !== null) return null;
  switch (resolveSidebarThreadStatus(shell)) {
    case "working":
      return { label: `${shell.title} · working`, tone: "working" };
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

export function recommendationKey(
  status: Pick<ProjectStatus, "id">,
  decision: Pick<ProjectStatusDecision, "openedAt">,
): string {
  return `${status.id}@${Date.parse(decision.openedAt)}`;
}

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

/**
 * Whether the one-tap answer is on its way: queued in the outbox, or already
 * sent while the server has not marked the decision answered yet.
 */
export function isRecommendationPending(input: {
  readonly status: Pick<ProjectStatus, "id" | "decision">;
  readonly queuedTexts: ReadonlyArray<string>;
  readonly sentKeys: ReadonlySet<string>;
}): boolean {
  const decision = input.status.decision;
  if (decision === undefined || decision.answeredAt !== undefined) return false;
  const key = recommendationKey(input.status, decision);
  return (
    input.sentKeys.has(key) ||
    input.queuedTexts.some((text) => recommendationKeyOfText(text) === key)
  );
}

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

// Replies: the composer's "Re: <workstream>" tag.

export interface StatusReplyTag {
  readonly title: string;
  readonly statusId?: string;
  readonly openedAt?: string;
}

/** A Reply on a row with a question names that version; a header Reply names the workstream only. */
export function statusReplyTagFor(
  status: Pick<ProjectStatus, "id" | "title" | "decision">,
  withQuestion: boolean,
): StatusReplyTag {
  return {
    title: status.title,
    statusId: status.id,
    ...(withQuestion && status.decision !== undefined
      ? { openedAt: status.decision.openedAt }
      : {}),
  };
}

/** The text a send carries: the composer text, prefixed when a Re: tag is set. */
export function applyStatusReplyTag(text: string, tag: StatusReplyTag | null): string {
  if (tag === null) return text;
  return tag.statusId === undefined
    ? statusReplyText(tag.title, text)
    : statusReplyText(tag.title, text, {
        statusId: tag.statusId,
        ...(tag.openedAt !== undefined ? { openedAt: tag.openedAt } : {}),
      });
}
