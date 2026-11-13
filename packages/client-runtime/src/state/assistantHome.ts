import {
  ASSISTANT_ASK_ACTIVITY_KIND,
  ASSISTANT_PING_ACTIVITY_KIND,
  AssistantAskActivityPayload,
  assistantAskAnswerText,
  assistantAskIdOf,
  AssistantPingPayload,
  findGlobalAssistantProject,
  isAgentPushMessageId,
  isGlobalAssistant,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThreadActivity,
  type ProjectStatus,
  type ProjectStatusDecision,
  sortProjectStatuses,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// Fork-owned. Pure view logic for the cross-Project Assistant, shared by web
// and mobile: which Project is the Assistant, what needs the user across every
// other Project, and the "asked N coordinators" cards in its conversation.

export { findGlobalAssistantProject, isGlobalAssistant };

/** Every Project except the Assistant itself; Projects lists use this. */
export function withoutGlobalAssistant<P extends OrchestrationProjectShell>(
  projects: ReadonlyArray<P>,
): P[] {
  return projects.filter((project) => !isGlobalAssistant(project));
}

/** One open Status question, with the Project it belongs to. */
export interface AssistantNeedsYouItem<P extends OrchestrationProjectShell> {
  readonly project: P;
  readonly status: ProjectStatus & { readonly decision: ProjectStatusDecision };
}

/** One workstream that is moving, with the Project it belongs to. */
export interface AssistantMovingItem<P extends OrchestrationProjectShell> {
  readonly project: P;
  readonly status: ProjectStatus;
}

function isLiveProject(project: OrchestrationProjectShell): boolean {
  const marker = project.assistant;
  return marker != null && marker.archivedAt == null && marker.scope !== "global";
}

/**
 * Open questions across every live Project, deadlines first, then newest.
 * `projectIds` limits it to the Assistant's reach; null is every Project.
 */
export function collectNeedsYou<P extends OrchestrationProjectShell>(
  projects: ReadonlyArray<P>,
  projectIds: ReadonlyArray<string> | null = null,
): AssistantNeedsYouItem<P>[] {
  const items: AssistantNeedsYouItem<P>[] = [];
  for (const project of projects) {
    if (!isLiveProject(project)) continue;
    if (projectIds !== null && !projectIds.includes(project.id)) continue;
    for (const status of project.assistant?.statuses ?? []) {
      const decision = status.decision;
      if (decision === undefined || decision.answeredAt !== undefined) continue;
      items.push({ project, status: { ...status, decision } });
    }
  }
  return items.toSorted((a, b) => {
    const aDeadline = a.status.decision.deadline;
    const bDeadline = b.status.decision.deadline;
    if (aDeadline !== undefined && bDeadline !== undefined) {
      return aDeadline.localeCompare(bDeadline);
    }
    if (aDeadline !== undefined) return -1;
    if (bDeadline !== undefined) return 1;
    return b.status.decision.openedAt.localeCompare(a.status.decision.openedAt);
  });
}

/** Working workstreams across every live Project, newest first. */
export function collectMoving<P extends OrchestrationProjectShell>(
  projects: ReadonlyArray<P>,
  projectIds: ReadonlyArray<string> | null = null,
): AssistantMovingItem<P>[] {
  const items: AssistantMovingItem<P>[] = [];
  for (const project of projects) {
    if (!isLiveProject(project)) continue;
    if (projectIds !== null && !projectIds.includes(project.id)) continue;
    for (const status of sortProjectStatuses(project.assistant?.statuses ?? [])) {
      if (status.state !== "working" || status.decision !== undefined) continue;
      items.push({ project, status });
    }
  }
  return items.toSorted((a, b) => b.status.updatedAt.localeCompare(a.status.updatedAt));
}

/** The Assistant's own workstreams: what it is doing for the user. */
export function assistantWorkingOn(
  assistant: OrchestrationProjectShell | undefined,
): ProjectStatus[] {
  return sortProjectStatuses(assistant?.assistant?.statuses ?? []).filter(
    (status) => status.state === "working" || status.state === "queued",
  );
}

// ── Asks ───────────────────────────────────────────────────────────

export interface AssistantAskAnswer {
  readonly messageId: string;
  readonly text: string;
  readonly createdAt: string;
}

export interface AssistantAskTargetView {
  readonly projectId: string;
  readonly title: string;
  readonly coordinatorThreadId: string;
  readonly answer: AssistantAskAnswer | null;
}

export interface AssistantAskCard {
  readonly askId: string;
  readonly activityId: string;
  readonly question: string;
  readonly createdAt: string;
  readonly targets: ReadonlyArray<AssistantAskTargetView>;
  readonly answeredCount: number;
}

const decodeAskPayload = Schema.decodeUnknownOption(AssistantAskActivityPayload);
const decodePingPayload = Schema.decodeUnknownOption(AssistantPingPayload);

/** Every ask the Assistant made in a thread, with the answers that came back. */
export function collectAskCards(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  messages: ReadonlyArray<
    Pick<OrchestrationMessage, "id" | "role" | "text" | "createdAt" | "source">
  >,
): AssistantAskCard[] {
  const answersByAsk = new Map<string, Map<string, AssistantAskAnswer>>();
  for (const message of messages) {
    if (message.role !== "user" || !isAgentPushMessageId(message.id)) continue;
    const askId = assistantAskIdOf(message.id);
    const from = message.source?.threadId;
    if (askId === null || from === undefined) continue;
    const byThread = answersByAsk.get(askId) ?? new Map<string, AssistantAskAnswer>();
    byThread.set(from, {
      messageId: message.id,
      text: assistantAskAnswerText(message.text),
      createdAt: message.createdAt,
    });
    answersByAsk.set(askId, byThread);
  }
  const cards: AssistantAskCard[] = [];
  for (const activity of activities) {
    if (activity.kind !== ASSISTANT_ASK_ACTIVITY_KIND) continue;
    const payload = decodeAskPayload(activity.payload);
    if (payload._tag === "None") continue;
    const answers = answersByAsk.get(payload.value.askId);
    const targets = payload.value.targets.map((target) => ({
      ...target,
      answer: answers?.get(target.coordinatorThreadId) ?? null,
    }));
    cards.push({
      askId: payload.value.askId,
      activityId: activity.id,
      question: payload.value.question,
      createdAt: activity.createdAt,
      targets,
      answeredCount: targets.filter((target) => target.answer !== null).length,
    });
  }
  return cards;
}

/** Message ids of answers already shown inside an ask card, which the timeline can hide. */
export function askAnswerMessageIds(cards: ReadonlyArray<AssistantAskCard>): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const card of cards) {
    for (const target of card.targets) {
      if (target.answer !== null) ids.add(target.answer.messageId);
    }
  }
  return ids;
}

export interface AssistantPing extends AssistantPingPayload {
  readonly activityId: string;
  readonly createdAt: string;
}

/** The Assistant's pings in a thread, newest first. */
export function collectPings(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): AssistantPing[] {
  const pings: AssistantPing[] = [];
  for (const activity of activities) {
    if (activity.kind !== ASSISTANT_PING_ACTIVITY_KIND) continue;
    const payload = decodePingPayload(activity.payload);
    if (payload._tag === "None") continue;
    pings.push({ ...payload.value, activityId: activity.id, createdAt: activity.createdAt });
  }
  return pings.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** "Good morning", "Good afternoon" or "Good evening" for a local hour. */
export function assistantGreeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
