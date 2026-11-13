import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  askAnswerMessageIds,
  collectAskCards,
  collectPings,
  isGlobalAssistant,
} from "@t3tools/client-runtime/state/assistant-home";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { newThreadId } from "~/lib/utils";
import { usePrimaryEnvironment } from "~/state/environments";
import { useProjects, useThreadShellsForProjectRefs } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { AssistantHeader, ASSISTANT_INBOX_CHANNEL } from "./AssistantHeader";
import { AssistantInbox } from "./AssistantInbox";
import { AssistantRail } from "./AssistantRail";
import {
  AssistantTimelineCardsContext,
  type AssistantTimelineCardsValue,
} from "./AssistantTimelineCards";
import { useSendToThread } from "./useAssistant";

// Fork-owned. Everything ChatView swaps in when the thread on screen is one
// of the Assistant's channels, kept here so ChatView only gains a few lines.

export interface AssistantChatChrome {
  readonly header: ReactNode;
  readonly rail: ReactNode;
  /** Replaces the timeline while the Inbox is selected. */
  readonly inbox: ReactNode | null;
  /** Answers shown inside ask cards, which the timeline leaves out. */
  readonly hiddenMessageIds: ReadonlySet<string>;
  readonly wrapTimeline: (timeline: ReactNode) => ReactNode;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

export function useAssistantChatChrome(input: {
  readonly project: EnvironmentProject | null;
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly runtimeMode: RuntimeMode;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly onOpenMemory: () => void;
}): AssistantChatChrome | null {
  const { project, environmentId, threadId } = input;
  const enabled = project !== null && environmentId !== null && isGlobalAssistant(project);
  const navigate = useNavigate();
  const projects = useProjects();
  const send = useSendToThread();
  const createThread = useAtomCommand(threadEnvironment.create, "create channel");
  const pinThread = useAtomCommand(threadEnvironment.pin, "pin channel");
  const [inboxOpenFor, setInboxOpenFor] = useState<string | null>(null);
  const reach = usePrimaryEnvironment()?.serverConfig?.settings.assistant?.projects ?? null;

  const projectRefs = useMemo(
    () =>
      enabled && project !== null
        ? [{ environmentId: project.environmentId, projectId: project.id }]
        : [],
    [enabled, project],
  );
  const homeThreads = useThreadShellsForProjectRefs(projectRefs);

  const asks = useMemo(
    () => (enabled ? collectAskCards(input.activities, input.messages) : []),
    [enabled, input.activities, input.messages],
  );
  const pings = useMemo(
    () => (enabled ? collectPings(input.activities) : []),
    [enabled, input.activities],
  );
  const hiddenMessageIds = useMemo(
    () => (asks.length > 0 ? askAnswerMessageIds(asks) : EMPTY_IDS),
    [asks],
  );
  const projectsById = useMemo(
    () =>
      new Map(
        projects
          .filter((candidate) => candidate.environmentId === environmentId)
          .map((candidate) => [candidate.id as string, candidate] as const),
      ),
    [environmentId, projects],
  );

  const goToThread = useCallback(
    (env: EnvironmentId, target: ThreadId) =>
      navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(env, target)),
      }),
    [navigate],
  );

  const replyHere = useCallback(
    (text: string) => {
      if (environmentId === null || threadId === null) return;
      void send({ environmentId, threadId, text, runtimeMode: input.runtimeMode });
    },
    [environmentId, input.runtimeMode, send, threadId],
  );

  const cardsValue = useMemo<AssistantTimelineCardsValue>(
    () => ({
      asksByActivityId: new Map(asks.map((card) => [card.activityId, card] as const)),
      pingsByActivityId: new Map(pings.map((ping) => [ping.activityId, ping] as const)),
      projectsById,
      onOpenCoordinator: (projectId) => {
        const target = projectsById.get(projectId);
        if (target?.assistant == null) return;
        void goToThread(target.environmentId, target.assistant.coordinatorThreadId);
      },
      onPingReply: replyHere,
    }),
    [asks, goToThread, pings, projectsById, replyHere],
  );

  if (!enabled || project === null || environmentId === null || threadId === null) return null;
  const coordinatorId = project.assistant!.coordinatorThreadId;
  const channelThreads = homeThreads
    .filter((thread) => thread.pinnedAt != null && thread.id !== coordinatorId)
    .filter((thread) => thread.archivedAt == null)
    .toSorted((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? ""));
  const channels = [
    { id: coordinatorId as string, label: "Today" },
    ...channelThreads.map((thread) => ({ id: thread.id as string, label: thread.title })),
  ];
  const inboxOpen = inboxOpenFor === threadId;
  const selected = inboxOpen ? ASSISTANT_INBOX_CHANNEL : (threadId as string);
  const schedules = project.assistant?.schedules ?? [];
  const channelSchedule = schedules.find(
    (schedule) =>
      schedule.enabled &&
      (schedule.target === threadId ||
        (schedule.target === "coordinator" && threadId === coordinatorId)),
  );
  const subtitle = inboxOpen
    ? "Pings from your Assistant"
    : threadId === coordinatorId
      ? "Talks to every Project coordinator and workspace"
      : channelSchedule
        ? `${channelSchedule.name} schedule`
        : "Channel";

  const createChannel = async (title: string) => {
    const id = newThreadId();
    const created = await createThread({
      environmentId,
      input: {
        threadId: id,
        projectId: project.id,
        title,
        modelSelection: project.defaultModelSelection ?? undefined,
        runtimeMode: input.runtimeMode,
        branch: null,
        worktreePath: null,
      } as never,
    });
    if (created._tag !== "Success") return;
    await pinThread({ environmentId, input: { threadId: id } as never });
    void goToThread(environmentId, id);
  };

  return {
    header: (
      <AssistantHeader
        subtitle={subtitle}
        channels={channels}
        selected={selected}
        inboxCount={pings.length}
        onSelect={(id) => {
          if (id === ASSISTANT_INBOX_CHANNEL) {
            setInboxOpenFor(threadId);
            return;
          }
          setInboxOpenFor(null);
          if (id !== threadId) void goToThread(environmentId, id as ThreadId);
        }}
        onCreateChannel={(title) => void createChannel(title)}
        onOpenMemory={input.onOpenMemory}
        onOpenSettings={() => void navigate({ to: "/settings/assistant" })}
      />
    ),
    rail: (
      <AssistantRail
        assistant={project}
        projects={projects.filter((candidate) => candidate.environmentId === environmentId)}
        reach={reach}
        asks={asks}
      />
    ),
    inbox: inboxOpen ? <AssistantInbox pings={pings} onReply={replyHere} /> : null,
    hiddenMessageIds,
    wrapTimeline: (timeline) => (
      <AssistantTimelineCardsContext value={cardsValue}>{timeline}</AssistantTimelineCardsContext>
    ),
  };
}
