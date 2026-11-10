import { resolveSidebarThreadStatus } from "@t3tools/client-runtime/state/thread-status";
import {
  PROJECT_STATUS_STALE_MS,
  countStatusesNeedingUser,
  isAutoAcceptArmed,
  parseStatusReply,
  statusReplyText,
  type OrchestrationThreadShell,
  type ProjectStatus,
  type ProjectStatusDecision,
  type ProjectStatusState,
} from "@t3tools/contracts";

import { formatElapsedDurationLabel } from "../../timestampFormat";

// Pure presentation for the coordinator's Status panel and composer strip.

export const STATUS_STATE_LABEL: Record<ProjectStatusState, string> = {
  "needs-you": "Needs you",
  working: "Working",
  done: "Done",
  queued: "Queued",
};

/** "5 workstreams · 2 need you". */
export function statusCountLine(statuses: ReadonlyArray<Pick<ProjectStatus, "state">>): string {
  const total = statuses.length;
  const needs = countStatusesNeedingUser(statuses);
  const base = `${total} ${total === 1 ? "workstream" : "workstreams"}`;
  return needs > 0 ? `${base} · ${needs} need${needs === 1 ? "s" : ""} you` : base;
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
 * The line under a decision about its deadline, or null when it has none or
 * the user already replied. Silence only ever reminds, unless the user opted
 * in to the recommendation for this exact version of the decision.
 */
export function describeDecisionDeadline(
  decision: ProjectStatusDecision,
  nowMs: number,
  locale?: string,
): { readonly text: string; readonly tone: DecisionDeadlineTone } | null {
  const { deadline } = decision;
  if (deadline === undefined || decision.answeredAt !== undefined) return null;
  if (decision.deadlineHandled?.outcome === "accepted") {
    return { text: "Recommendation sent at the deadline.", tone: "handled" };
  }
  // Armed and past due: the server's sweep is about to send it.
  if (
    decision.deadlineHandled === undefined &&
    isDeadlineOverdue(deadline, nowMs) &&
    isAutoAcceptArmed(decision)
  ) {
    return { text: "Sending the recommendation now.", tone: "handled" };
  }
  if (decision.deadlineHandled?.outcome === "reminded" || isDeadlineOverdue(deadline, nowMs)) {
    return { text: "Deadline passed, still waiting on you.", tone: "overdue" };
  }
  const when = formatDeadlineShort(deadline, nowMs, locale);
  return {
    text: isAutoAcceptArmed(decision)
      ? `No reply by ${when}: I'll go with the recommendation.`
      : `No reply by ${when}: I'll remind you and keep waiting.`,
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

const RECOMMENDATION_BODY_PREFIX = "Go with your recommendation:";

/** The message "Go with recommendation" sends, naming the workstream and the question's version. */
export function recommendationReplyText(
  status: Pick<ProjectStatus, "id" | "title">,
  decision: Pick<ProjectStatusDecision, "recommendation" | "openedAt">,
): string {
  return statusReplyText(status.title, `${RECOMMENDATION_BODY_PREFIX} ${decision.recommendation}`, {
    statusId: status.id,
    openedAt: decision.openedAt,
  });
}

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
    !reply.body.startsWith(RECOMMENDATION_BODY_PREFIX)
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
