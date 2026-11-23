import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  askAnswerMessageIds,
  collectAskCards,
  collectPings,
  isGlobalAssistant,
} from "@t3tools/client-runtime/state/assistant-home";
import { taskCounts } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  ASSISTANT_BRIEF_SCHEDULE_ID,
  type EnvironmentId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { describeCadence } from "@t3tools/shared/schedules";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useMemo } from "react";

import { useProjects, useThreadShellsForProjectRefs } from "~/state/entities";
import { useTaskToday, useTasks } from "~/state/tasks";
import { buildThreadRouteParams } from "../../threadRoutes";
import { AssistantHeader } from "./AssistantHeader";
import { AssistantInbox } from "./AssistantInbox";
import { useAssistantInboxState } from "./useAssistantInboxState";
import { AssistantOverview } from "./AssistantOverview";
import { AssistantStatusBoard } from "./AssistantStatusBoard";
import { AssistantTodayEmpty } from "./AssistantTodayEmpty";
import {
  AssistantTimelineCardsContext,
  type AssistantTimelineCardsValue,
} from "./AssistantTimelineCards";
import { useAssistantHomeEnvironment, useSendToThread } from "./useAssistant";

import { useAssistantNeedsYou } from "./useAssistantNeedsYou";

// Fork-owned. Everything ChatView swaps in when the thread on screen is one
// of the Assistant's channels, kept here so ChatView only gains a few lines.

export interface AssistantChatChrome {
  readonly header: ReactNode;
  /** The Overview right-panel tab: Needs you, Working on and Today. */
  readonly overview: ReactNode;
  /** The Status right-panel tab: one Project's board at a time. */
  readonly statusBoard: ReactNode;
  /** Replaces the timeline while the Inbox is selected. */
  readonly inbox: ReactNode | null;
  /** Shown in place of the empty timeline before a channel has messages. */
  readonly emptyTimeline: ReactNode;
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
  readonly onOpenSchedules?: (() => void) | undefined;
  readonly rightPanelOpen: boolean;
}): AssistantChatChrome | null {
  const { project, environmentId, threadId } = input;
  const enabled = project !== null && environmentId !== null && isGlobalAssistant(project);
  const navigate = useNavigate();
  const projects = useProjects();
  const send = useSendToThread();
  const inboxKey = `${environmentId}:${threadId}`;
  const assistantSettings = useAssistantHomeEnvironment()?.serverConfig?.settings.assistant ?? null;
  const reach = assistantSettings?.projects ?? null;
  const needsYou = useAssistantNeedsYou();
  const { tasks } = useTasks();
  const taskToday = useTaskToday();
  const tasksTodayCount = useMemo(
    () => (enabled ? taskCounts(tasks, taskToday).today : 0),
    [enabled, taskToday, tasks],
  );

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
  const { unreadCount, onOpenChange } = useAssistantInboxState(inboxKey, pings);
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

  const environmentProjects = useMemo(
    () => projects.filter((candidate) => candidate.environmentId === environmentId),
    [environmentId, projects],
  );
  const needsYouCount = needsYou.length;

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
  const schedules = project.assistant?.schedules ?? [];
  const channelSchedule = schedules.find(
    (schedule) =>
      schedule.enabled &&
      (schedule.target === threadId ||
        (schedule.target === "coordinator" && threadId === coordinatorId)),
  );
  const description =
    threadId === coordinatorId
      ? "Talks to every Project coordinator and workspace"
      : channelSchedule
        ? `${channelLabelFor(channelThreads, threadId)} · ${describeCadence(channelSchedule.cron)}`
        : "Channel";
  const briefSchedule = schedules.find(
    (schedule) => schedule.id === ASSISTANT_BRIEF_SCHEDULE_ID && schedule.enabled,
  );
  const tasksReach = assistantSettings?.tasks ?? "edit";
  const openTasks = () => void navigate({ to: "/tasks/$view", params: { view: "today" } });
  const openSettings = () => void navigate({ to: "/settings/assistant" });

  return {
    header: (
      <AssistantHeader
        key={inboxKey}
        description={description}
        inboxCount={unreadCount}
        inbox={<AssistantInbox pings={pings} onReply={replyHere} />}
        onInboxOpenChange={onOpenChange}
        onOpenMemory={input.onOpenMemory}
        onOpenSchedules={input.onOpenSchedules}
        rightPanelOpen={input.rightPanelOpen}
      />
    ),
    overview: (
      <AssistantOverview
        assistant={project}
        needsYou={needsYou}
        asks={asks}
        tasksToday={tasksReach === "off" ? null : { count: tasksTodayCount, onOpen: openTasks }}
      />
    ),
    statusBoard: (
      <AssistantStatusBoard
        projects={environmentProjects.filter(
          (candidate) =>
            candidate.assistant != null &&
            candidate.assistant.archivedAt == null &&
            !isGlobalAssistant(candidate) &&
            (reach === null || reach.includes(candidate.id)),
        )}
      />
    ),
    emptyTimeline: (
      <AssistantTodayEmpty
        kind={threadId === coordinatorId ? "today" : "channel"}
        channelLabel={channelLabelFor(channelThreads, threadId)}
        briefTime={briefSchedule ? (assistantSettings?.briefTime ?? "07:00") : null}
        briefDays={assistantSettings?.briefDays ?? "weekdays"}
        needsYouCount={needsYouCount}
        tasksTodayCount={tasksReach === "off" ? null : tasksTodayCount}
        now={new Date()}
        onOpenSettings={openSettings}
        onOpenTasks={openTasks}
      />
    ),
    inbox: null,
    hiddenMessageIds,
    wrapTimeline: (timeline) => (
      <AssistantTimelineCardsContext value={cardsValue}>{timeline}</AssistantTimelineCardsContext>
    ),
  };
}

function channelLabelFor(
  channels: ReadonlyArray<{ readonly id: string; readonly title: string }>,
  threadId: string,
): string {
  return channels.find((channel) => channel.id === threadId)?.title ?? "Channel";
}
