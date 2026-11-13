import type {
  AssistantAskCard,
  AssistantNeedsYouItem,
} from "@t3tools/client-runtime/state/assistant-home";
import {
  ASSISTANT_BRIEF_SCHEDULE_ID,
  SCHEDULE_MESSAGE_PREFIX,
  findGlobalAssistantProject,
  statusReplyText,
  type EnvironmentId,
  type OrchestrationProjectShell,
  type ProjectStatus,
  type ProjectStatusDecision,
} from "@t3tools/contracts";

// Fork-owned. Pure view logic of the iPhone Assistant screen: which
// environment hosts it, the morning brief card, where ask cards sit in the
// feed, and the text a one-tap answer sends.

/** The button label of a Status question: its short answer, or the generic one. */
export function needsYouAnswerLabel(decision: Pick<ProjectStatusDecision, "answer">): string {
  return decision.answer ?? "Go with recommendation";
}

const RECOMMENDATION_BODY_PREFIX = "Go with your recommendation:";

/**
 * The message the answer button sends to the Project's coordinator. Mirrors
 * the web's `recommendationReplyText`, so the coordinator reads the same
 * `Re: <title> [status:<id>@<revision>]` header either way.
 */
export function recommendationReplyText(
  status: Pick<ProjectStatus, "id" | "title">,
  decision: Pick<ProjectStatusDecision, "recommendation" | "openedAt">,
): string {
  return statusReplyText(status.title, `${RECOMMENDATION_BODY_PREFIX} ${decision.recommendation}`, {
    statusId: status.id,
    openedAt: decision.openedAt,
  });
}

/** The draft "Reply" starts in the coordinator's composer: the same header, empty body. */
export function statusReplyDraft(
  status: Pick<ProjectStatus, "id" | "title">,
  decision: Pick<ProjectStatusDecision, "openedAt">,
): string {
  return statusReplyText(status.title, "", { statusId: status.id, openedAt: decision.openedAt });
}

/** `<statusId>@<revision>`: one version of one workstream's question. */
export function needsYouKey(
  status: Pick<ProjectStatus, "id">,
  decision: Pick<ProjectStatusDecision, "openedAt">,
): string {
  return `${status.id}@${Date.parse(decision.openedAt)}`;
}

/** "3 need you" and the titles beside it, for the pill above the composer. */
export function needsYouPillText<P extends OrchestrationProjectShell>(
  items: ReadonlyArray<AssistantNeedsYouItem<P>>,
): {
  readonly count: string;
  readonly titles: string;
} {
  return {
    count: `${items.length} need${items.length === 1 ? "s" : ""} you`,
    titles: items.map((item) => item.status.title).join(", "),
  };
}

interface BriefMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
}

export interface AssistantBrief {
  readonly messageId: string;
  readonly firstLine: string;
  readonly text: string;
  readonly createdAt: string;
}

/**
 * The latest morning brief: the Assistant's first reply after the newest
 * `cp-schedule:<projectId>:morning-brief:` prompt. Null until one exists in
 * the loaded window, or while the reply is still empty.
 */
export function latestAssistantBrief(
  messages: ReadonlyArray<BriefMessage>,
  projectId: string,
): AssistantBrief | null {
  const prefix = `${SCHEDULE_MESSAGE_PREFIX}${projectId}:${ASSISTANT_BRIEF_SCHEDULE_ID}:`;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const prompt = messages[index]!;
    if (prompt.role !== "user" || !prompt.id.startsWith(prefix)) continue;
    const reply = messages
      .slice(index + 1)
      .find((message) => message.role === "assistant" && message.text.trim().length > 0);
    if (reply === undefined) return null;
    const text = reply.text.trim();
    const firstLine =
      text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? text;
    return { messageId: reply.id, firstLine, text, createdAt: reply.createdAt };
  }
  return null;
}

interface AnchorEntry {
  readonly id: string;
  readonly type: string;
  readonly createdAt: string;
  readonly message?: { readonly role: string };
}

/**
 * Feed entry id each ask card renders under: the first assistant message at
 * or after the ask, so the cards sit inside the reply that made them. An ask
 * whose reply has not arrived yet sits under the last entry.
 */
export function anchorAskCards(
  feed: ReadonlyArray<AnchorEntry>,
  cards: ReadonlyArray<AssistantAskCard>,
): ReadonlyMap<string, ReadonlyArray<AssistantAskCard>> {
  const anchored = new Map<string, AssistantAskCard[]>();
  const last = feed.at(-1);
  if (last === undefined) return anchored;
  for (const card of cards) {
    const anchor =
      feed.find(
        (entry) =>
          entry.type === "message" &&
          entry.message?.role === "assistant" &&
          entry.createdAt >= card.createdAt,
      ) ?? last;
    const list = anchored.get(anchor.id) ?? [];
    list.push(card);
    anchored.set(anchor.id, list);
  }
  return anchored;
}

/** Drops answer messages an ask card already shows. Keeps the array identity when none match. */
export function withoutAnsweredMessages<
  E extends { readonly type: string; readonly message?: { readonly id: string } },
>(feed: ReadonlyArray<E>, hiddenIds: ReadonlySet<string>): ReadonlyArray<E> {
  if (hiddenIds.size === 0) return feed;
  const kept = feed.filter(
    (entry) =>
      entry.type !== "message" || entry.message === undefined || !hiddenIds.has(entry.message.id),
  );
  return kept.length === feed.length ? feed : kept;
}

interface AssistantEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly supportsAssistants: boolean;
}

/**
 * Where the Home row opens the Assistant: the environment that already hosts
 * it, else the first connected one whose server runs Projects. Null hides the row.
 */
export function pickAssistantEnvironment<
  P extends OrchestrationProjectShell & { readonly environmentId: EnvironmentId },
>(
  environments: ReadonlyArray<AssistantEnvironmentCandidate>,
  projects: ReadonlyArray<P>,
): { readonly environmentId: EnvironmentId; readonly project: P | null } | null {
  const usable = environments.filter((entry) => entry.connected && entry.supportsAssistants);
  for (const entry of usable) {
    const project = findGlobalAssistantProject(
      projects.filter((candidate) => candidate.environmentId === entry.environmentId),
    );
    if (project !== undefined) return { environmentId: entry.environmentId, project };
  }
  const first = usable[0];
  return first === undefined ? null : { environmentId: first.environmentId, project: null };
}

/** "7:02 AM" in the device's locale. */
export function briefTimeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
