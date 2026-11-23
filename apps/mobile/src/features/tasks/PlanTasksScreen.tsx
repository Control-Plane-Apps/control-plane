import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { selectTaskProjectOptions } from "@t3tools/client-runtime/state/assistants";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  allTasks,
  backlogTasks,
  committedTasks,
  completedToday,
  filterTasksByProject,
  formatTaskPeriodTitle,
  formatTaskRange,
  formatTaskShortDate,
  formatTaskMonthDay,
  formatTaskWeekday,
  formatUpcomingOffset,
  formatTaskDayTitle,
  homeForMove,
  decodeTaskHighlight,
  proposedTasksForView,
  proposedTasksOnDate,
  taskAgentState,
  taskCounts,
  taskIntentFor,
  dayDropHome,
  todayTasks,
  upcomingTasks,
  type TaskBacklogFilter,
  type TaskLifecycleProject,
} from "@t3tools/client-runtime/state/projects";
import {
  findGlobalAssistantProject,
  taskPeriodFor,
  TASK_INTENT_MAX,
  type ProjectStatus,
  type Task,
  type TaskHorizon,
  type ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { cn } from "../../lib/cn";
import { useThreadShells } from "../../state/entities";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { recommendationReplyText, statusReplyTagFor } from "../status/projectStatus.logic";
import { prepareStatusReply } from "../status/ProjectStatusRouteScreen";
import { sendThreadMessage } from "../status/statusReplyStore";
import { PlanTaskRow, type PlanTaskRowContext } from "./PlanTaskRow";
import { ReorderableTaskRows, type TaskDropTargets } from "./ReorderableTaskRows";
import { CHECK_OFF_LINGER_MS, withLingeringTasks } from "./taskCheckOff";
import { autoScrollDelta, dayDropTarget, planTaskReorder } from "./taskReorder";
import { ProposedTasks } from "./ProposedTasks";
import { useOptimisticTaskHomes } from "./useOptimisticTaskHomes";
import { useHandToAssistant } from "./taskHandoff";
import {
  RowSeparator,
  SectionLabel,
  symbol,
  TaskCard,
  UndoBanner,
  useTaskPalette,
  useUndoNotice,
  BARE_INPUT_STYLE,
} from "./taskUi";
import { cloudTaskStore } from "./cloudTasks";
import { useMobileTaskStore, useTaskToday } from "./useMobileTasks";

// Fork-owned. Personal tasks on phone and iPad: Today, Week, Month, Year,
// Upcoming and All tasks in one view switched by a chip row (the same model as
// desktop), with select mode, Move, quick add, hand to agent, and long-press
// drag onto a range chip. Named "Plan" in code so it is never confused with
// the thread list's old "tasks".

export type PlanTasksView = "today" | TaskHorizon | "upcoming" | "all";

type PlanTasksParams =
  | {
      readonly view?: PlanTasksView;
      /** Task ids to light up briefly, comma separated (from a chat's proposal block). */
      readonly highlight?: string;
    }
  | undefined;

const HIGHLIGHT_MS = 2400;

const RANGES: ReadonlyArray<{ readonly view: PlanTasksView; readonly label: string }> = [
  { view: "today", label: "Today" },
  { view: "week", label: "Week" },
  { view: "month", label: "Month" },
  { view: "year", label: "Year" },
  { view: "upcoming", label: "Upcoming" },
  { view: "all", label: "All tasks" },
];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Drop-target keys for Upcoming's day cards (range chips use their view name). */
const DAY_TARGET_PREFIX = "day:";

/** The bubble over a range chip while a task hovers it. */
function dropLabel(view: PlanTasksView, today: string): string | null {
  switch (view) {
    case "today":
      return "Move to today";
    case "week":
      return "Move to this week";
    case "month":
      return `Move to ${MONTHS[Number(today.slice(5, 7)) - 1]}`;
    case "year":
      return `Move to ${today.slice(0, 4)}`;
    default:
      return null;
  }
}

const WIDE_LAYOUT_MIN_WIDTH = 700;

type ProjectFilter = string | "none" | null;

export function PlanTasksScreen({ route }: StaticScreenProps<PlanTasksParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const workspace = useAdaptiveWorkspaceLayout();
  const { usesSplitView } = workspace.layout;
  // The pane's own width: beside the iPad sidebar it is narrower than the window.
  const [paneWidth, setPaneWidth] = useState(width);
  const wide = paneWidth >= WIDE_LAYOUT_MIN_WIDTH;
  const today = useTaskToday();
  const { tasks: storeTasks, intents, projects, actions, available, source } = useMobileTaskStore();
  const { tasks, move: moveTask } = useOptimisticTaskHomes(storeTasks, actions.move);
  const threads = useThreadShells();
  const handToAssistant = useHandToAssistant();
  const undo = useUndoNotice();
  const showUndo = undo.show;

  const [view, setViewState] = useState<PlanTasksView>(route.params?.view ?? "today");
  const [dropHover, setDropHover] = useState<string | null>(null);
  const chipFrames = useRef(
    new Map<string, { x: number; y: number; width: number; height: number }>(),
  );
  // Upcoming's day cards, in window coordinates, as long-press drop targets.
  const dayRefs = useRef(new Map<string, View | null>());
  const dayFrames = useRef(
    new Map<string, { x: number; y: number; width: number; height: number }>(),
  );
  const measureDays = useCallback(() => {
    for (const [date, node] of dayRefs.current) {
      node?.measureInWindow((x, y, width, height) => {
        dayFrames.current.set(date, { x, y, width, height });
      });
    }
  }, []);
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>(null);
  const [backlogFilter, setBacklogFilter] = useState<TaskBacklogFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [showCompleted, setShowCompleted] = useState(false);
  const setView = useCallback((next: PlanTasksView) => {
    setViewState(next);
    setExpandedId(null);
  }, []);

  // Opened again from a chat (the screen may already be mounted): switch to
  // the asked range and light up the tasks it names for a moment.
  const paramView = route.params?.view;
  const paramHighlight = route.params?.highlight;
  const [highlightIds, setHighlightIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (paramView !== undefined) setView(paramView);
    const ids = decodeTaskHighlight(paramHighlight);
    setHighlightIds(new Set(ids));
    if (ids.length === 0) return;
    const timer = setTimeout(() => setHighlightIds(new Set()), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [paramHighlight, paramView, setView]);

  // Pull to refresh: with Task Sync this pushes the phone's queued edits and
  // pulls now; tasks read through the Mac are already live, so the spinner
  // just confirms. Foreground and a timer sync too (cloudTasks.ts).
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    const minimum = new Promise((resolve) => setTimeout(resolve, 400));
    try {
      await Promise.all([
        source === "cloud"
          ? cloudTaskStore()
              .recheck(0)
              .catch(() => undefined)
          : undefined,
        minimum,
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [source]);

  // Opening Tasks rechecks whether Task Sync has been switched on (at most once a minute).
  useEffect(() => {
    void cloudTaskStore().recheck();
  }, []);

  const openThread = useCallback(
    (project: EnvironmentProject, threadId: ThreadId) => {
      const params = { environmentId: String(project.environmentId), threadId: String(threadId) };
      if (usesSplitView) navigation.navigate("Thread", params);
      else navigation.dispatch(StackActions.push("Thread", params));
    },
    [navigation, usesSplitView],
  );

  // Lucive mobile's check-off (taskCheckOff.ts): write now, keep the checked
  // row in its list for CHECK_OFF_LINGER_MS, then let the list drop it.
  const [lingering, setLingering] = useState<ReadonlySet<string>>(() => new Set());
  const lingerTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const linger = useCallback((taskId: string) => {
    setLingering((current) => new Set(current).add(taskId));
    const existing = lingerTimers.current.get(taskId);
    if (existing !== undefined) clearTimeout(existing);
    lingerTimers.current.set(
      taskId,
      setTimeout(() => {
        lingerTimers.current.delete(taskId);
        setLingering((current) => {
          const next = new Set(current);
          next.delete(taskId);
          return next;
        });
      }, CHECK_OFF_LINGER_MS),
    );
  }, []);
  useEffect(() => {
    const timers = lingerTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);
  /** What the open lists are built from: just-completed rows keep their place. */
  const listTasks = useMemo(() => withLingeringTasks(tasks, lingering), [tasks, lingering]);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  const context: PlanTaskRowContext = useMemo(
    () => ({
      today,
      actions,
      projects,
      onComplete: (task: Task) => {
        linger(task.id);
        void actions.setCompleted(task, true).then((ok) => {
          if (ok) showUndo(`Completed ${task.title}`, () => void actions.setCompleted(task, false));
        });
      },
      onMove: (task: Task, mode?: "schedule") =>
        navigation.navigate("TaskMove", { taskIds: task.id, ...(mode ? { mode } : {}) }),
      onEnterSelect: (task: Task) => {
        setExpandedId(null);
        setSelecting(true);
        setSelectedIds(new Set([task.id]));
      },
      onHandToAssistant: (task: Task) => void handToAssistant([task]),
      onOpenStatus: (project: EnvironmentProject) =>
        navigation.navigate("ProjectStatus", {
          environmentId: String(project.environmentId),
          projectId: String(project.id),
        }),
      onAnswerStatus: (project: EnvironmentProject, status: ProjectStatus) => {
        const coordinatorId = project.assistant?.coordinatorThreadId;
        if (coordinatorId === undefined || status.decision === undefined) return;
        void sendThreadMessage({
          environmentId: project.environmentId,
          threadId: coordinatorId,
          text: recommendationReplyText(status, status.decision),
        });
      },
      onReplyStatus: (project: EnvironmentProject, status: ProjectStatus) => {
        const threadId = prepareStatusReply(project, statusReplyTagFor(status, true));
        if (threadId !== null) openThread(project, threadId);
      },
      onOpenThread: openThread,
    }),
    [actions, handToAssistant, linger, navigation, openThread, projects, showUndo, today],
  );

  const lifecycleProjects = projects as ReadonlyArray<TaskLifecycleProject>;
  const visible = useCallback(
    (list: ReadonlyArray<Task>) => filterTasksByProject(list, projectFilter),
    [projectFilter],
  );

  const toggleExpanded = useCallback(
    (id: string) => setExpandedId((current) => (current === id ? null : id)),
    [],
  );
  const toggleSelected = useCallback(
    (id: string) =>
      setSelectedIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  const [reordering, setReordering] = useState(false);
  // The day whose row is lifted: its section is raised above the others so the
  // row stays visible as it travels over them.
  const [liftedDate, setLiftedDate] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const scrollMetrics = useRef({ offset: 0, content: 0, viewport: 0, top: 0 });
  const measureScroll = useCallback(() => {
    (scrollRef.current as unknown as View | null)?.measureInWindow((_x, y, _w, height) => {
      scrollMetrics.current.top = y;
      scrollMetrics.current.viewport = height;
    });
  }, []);
  const setDragActive = useCallback(
    (active: boolean, task: Task | null) => {
      setReordering(active);
      setLiftedDate(active && task?.home.kind === "date" ? task.home.date : null);
      // The page can have scrolled since the cards last reported their frames.
      if (active) {
        measureDays();
        measureScroll();
      }
    },
    [measureDays, measureScroll],
  );
  /** Scrolls while a lifted row's finger is near the top or bottom edge. */
  const autoScroll = useCallback((y: number) => {
    const metrics = scrollMetrics.current;
    const delta = autoScrollDelta({ y, ...metrics });
    if (delta === 0) return 0;
    metrics.offset += delta;
    scrollRef.current?.scrollTo({ y: metrics.offset, animated: false });
    // The day cards moved with the content; keep their frames in step.
    for (const [date, frame] of dayFrames.current) {
      dayFrames.current.set(date, { ...frame, y: frame.y - delta });
    }
    return delta;
  }, []);
  const reorder = useCallback(
    (list: ReadonlyArray<Task>, from: number, to: number) => {
      for (const assignment of planTaskReorder(list, from, to)) {
        const task = list.find((candidate) => candidate.id === assignment.id);
        if (task !== undefined)
          void actions.patch(task, { orderKey: assignment.orderKey as never });
      }
    },
    [actions],
  );

  const dropTargets: TaskDropTargets = {
    hitTest: (x, y, lifted) => {
      if (view === "upcoming") {
        const { top, viewport } = scrollMetrics.current;
        const date = dayDropTarget(dayFrames.current, x, y, lifted, {
          top,
          bottom: top + viewport,
        });
        if (date !== null) return `${DAY_TARGET_PREFIX}${date}`;
      }
      for (const [target, frame] of chipFrames.current) {
        if (dropLabel(target as PlanTasksView, today) === null) continue;
        if (
          x >= frame.x - 6 &&
          x <= frame.x + frame.width + 6 &&
          y >= frame.y - 12 &&
          y <= frame.y + frame.height + 12
        ) {
          return target;
        }
      }
      return null;
    },
    onHover: setDropHover,
    autoScroll: view === "upcoming" ? autoScroll : undefined,
    onDrop: (task, target) => {
      if (target.startsWith(DAY_TARGET_PREFIX)) {
        const home = dayDropHome(task, target.slice(DAY_TARGET_PREFIX.length), today);
        if (home !== null) void moveTask(task, home);
        return;
      }
      const move =
        target === "today"
          ? ({ kind: "today" } as const)
          : target === "week" || target === "month" || target === "year"
            ? ({ kind: "commit", horizon: target } as const)
            : null;
      if (move !== null) void moveTask(task, homeForMove(move, task.home, today));
    },
  };

  const renderList = (
    list: ReadonlyArray<Task>,
    options?: {
      hidePeriod?: boolean;
      /** Rows already sit under their day's label (Upcoming). */
      hideDay?: boolean;
      trailing?: boolean;
      reorderable?: boolean;
    },
  ) => (
    <ReorderableTaskRows
      tasks={list}
      enabled={options?.reorderable === true && !selecting}
      onReorder={reorder}
      onDragActiveChange={setDragActive}
      dropTargets={!wide || view === "upcoming" ? dropTargets : undefined}
      renderRow={(listed, index) => {
        // A lingering row is listed as open but renders the real, checked task.
        const task = taskById.get(listed.id) ?? listed;
        return (
          <>
            {index > 0 ? <RowSeparator /> : null}
            <PlanTaskRow
              task={task}
              state={taskAgentState(task, threads, lifecycleProjects)}
              context={context}
              expanded={expandedId === task.id}
              onToggleExpanded={toggleExpanded}
              selecting={selecting}
              selected={selectedIds.has(task.id)}
              onToggleSelected={toggleSelected}
              hidePeriod={options?.hidePeriod}
              hideDay={options?.hideDay}
              metaPlacement={options?.trailing ? "trailing" : "below"}
              highlighted={highlightIds.has(task.id)}
            />
          </>
        );
      }}
    />
  );

  const renderCompleted = (completed: ReadonlyArray<Task>) => {
    const done = visible(completed).filter((task) => !lingering.has(task.id));
    return done.length > 0 ? (
      <>
        <TextLink
          label={showCompleted ? "Hide completed" : `Show completed · ${done.length}`}
          onPress={() => setShowCompleted((value) => !value)}
          align="left"
        />
        {showCompleted ? <TaskCard>{renderList(done)}</TaskCard> : null}
      </>
    ) : null;
  };

  const openQuickAdd = (horizon: "today" | TaskHorizon | "backlog") =>
    navigation.navigate("TaskQuickAdd", {
      horizon,
      ...(horizon === "backlog" &&
      (backlogFilter === "week" || backlogFilter === "month" || backlogFilter === "year")
        ? { backlog: backlogFilter }
        : {}),
      ...(projectFilter !== null && projectFilter !== "none" ? { projectId: projectFilter } : {}),
    });
  /** Quick add from the header defaults to the range you are on. */
  const quickAddHorizon: "today" | TaskHorizon | "backlog" =
    view === "week" || view === "month" || view === "year"
      ? view
      : view === "all"
        ? "backlog"
        : "today";

  const addRow = (label: string, horizon: "today" | TaskHorizon | "backlog") => (
    <AddTaskRow label={label} onPress={() => openQuickAdd(horizon)} />
  );

  const counts = taskCounts(tasks, today);
  const selectedTasks = tasks.filter((task) => selectedIds.has(task.id));

  let title: string;
  let subtitle: string | null = null;
  let content: ReactNode;
  switch (view) {
    case "today": {
      title = formatTaskWeekday(today);
      subtitle = formatTaskMonthDay(today);
      const open = visible(todayTasks(listTasks, today));
      const proposals = visible(proposedTasksForView(tasks, "today", today));
      const done = visible(completedToday(tasks, today));
      content = (
        <>
          <ProposedTasks
            tasks={proposals}
            projects={projects}
            today={today}
            actions={actions}
            highlightIds={highlightIds}
          />
          {open.length === 0 && proposals.length === 0 ? (
            <>
              <View className="pt-4">
                <TaskCard>{addRow("Add a task", "today")}</TaskCard>
              </View>
              {/* First run shows only the add row; later, an empty day points elsewhere. */}
              {tasks.length === 0 ? null : (
                <View className="items-center gap-1 pt-28">
                  <Text className="pb-3 text-[17px] text-foreground-muted">
                    Nothing on today's plate.
                  </Text>
                  <TextLink label="View upcoming tasks" onPress={() => setView("upcoming")} />
                  <TextLink label="View all tasks" onPress={() => setView("all")} />
                </View>
              )}
            </>
          ) : (
            <>
              <SectionLabel>Today</SectionLabel>
              <TaskCard>
                {renderList(open, { hidePeriod: false, reorderable: true })}
                {open.length > 0 ? <RowSeparator /> : null}
                {addRow("Add a task", "today")}
              </TaskCard>
            </>
          )}
          {renderCompleted(done)}
        </>
      );
      break;
    }
    case "week":
    case "month":
    case "year": {
      const horizon: TaskHorizon = view;
      const period = taskPeriodFor(horizon, today);
      title =
        horizon === "week"
          ? `Week of ${formatTaskShortDate(period.startsOn)}`
          : formatTaskPeriodTitle(horizon, period.startsOn);
      subtitle = formatTaskRange(period.startsOn, period.endsOn);
      const committed = visible(committedTasks(listTasks, horizon, today));
      const backlog = backlogTasks(tasks, horizon).length;
      const intent = taskIntentFor(intents, horizon, today);
      const proposals = visible(proposedTasksForView(tasks, horizon, today));
      content = (
        <>
          <View className="pt-3">
            <TaskCard>
              <View className="px-4 pb-3 pt-2.5">
                <Text className="pb-0.5 text-[13px] text-foreground-muted">Intent</Text>
                <IntentLine
                  key={`${horizon}:${period.startsOn}:${intent?.text ?? ""}`}
                  value={intent?.text ?? ""}
                  placeholder={`Set this ${horizon}'s intent`}
                  onCommit={(text) => void actions.setIntent(horizon, period.startsOn, text)}
                />
              </View>
            </TaskCard>
          </View>
          <ProposedTasks
            tasks={proposals}
            projects={projects}
            today={today}
            actions={actions}
            highlightIds={highlightIds}
          />
          <SectionLabel>Committed</SectionLabel>
          <TaskCard>
            {renderList(committed, { hidePeriod: true, reorderable: true })}
            {committed.length > 0 ? <RowSeparator /> : null}
            {addRow("Add a commitment", horizon)}
          </TaskCard>
          {renderCompleted(committedTasks(tasks, horizon, today, "completed"))}
          <TextLink
            label={`${horizon[0]!.toUpperCase()}${horizon.slice(1)} backlog · ${backlog}`}
            align="left"
            onPress={() => {
              setView("all");
              setBacklogFilter(horizon);
            }}
          />
        </>
      );
      break;
    }
    case "upcoming": {
      title = "Upcoming";
      subtitle = "Next 7 days";
      const completedGroups = upcomingTasks(tasks, today, 7, "completed");
      const groups = upcomingTasks(listTasks, today).map((group, index) => ({
        ...group,
        done: completedGroups[index]?.tasks ?? [],
        tasks: visible(group.tasks),
        proposals: visible(proposedTasksOnDate(tasks, group.date)),
      }));
      content = (
        <>
          {groups.map((group) => (
            <DayDropZone
              key={group.date}
              date={group.date}
              title={formatTaskDayTitle(group.date)}
              weekday={formatTaskWeekday(group.date)}
              offset={formatUpcomingOffset(group.date, today)}
              count={group.tasks.length}
              hovering={dropHover === `${DAY_TARGET_PREFIX}${group.date}`}
              lifted={liftedDate === group.date}
              dragging={reordering}
              refs={dayRefs.current}
              onMeasure={measureDays}
            >
              <ProposedTasks
                tasks={group.proposals}
                projects={projects}
                today={today}
                actions={actions}
                highlightIds={highlightIds}
                inline
              />
              {group.proposals.length > 0 && group.tasks.length > 0 ? (
                <RowSeparator inset={0} />
              ) : null}
              {renderList(group.tasks, { reorderable: true, hideDay: true })}
              {group.tasks.length > 0 ? <RowSeparator /> : null}
              <AddTaskRow
                label="Add a task"
                onPress={() =>
                  navigation.navigate("TaskQuickAdd", {
                    horizon: "today",
                    date: group.date,
                    ...(projectFilter !== null && projectFilter !== "none"
                      ? { projectId: projectFilter }
                      : {}),
                  })
                }
              />
              {renderCompleted(group.done)}
            </DayDropZone>
          ))}
        </>
      );
      break;
    }
    case "all": {
      title = "All tasks";
      const result = allTasks(visible(listTasks), backlogFilter);
      const proposals = visible(proposedTasksForView(tasks, "all", today, backlogFilter));
      content = (
        <>
          <BacklogFilters
            value={backlogFilter}
            completed={result.completed}
            onChange={setBacklogFilter}
          />
          {backlogFilter === "completed" ? (
            <View className="pt-1">
              {result.done.length > 0 ? (
                <TaskCard>{renderList(result.done, { trailing: true })}</TaskCard>
              ) : (
                <Text className="px-9 pt-4 text-[15px] text-foreground-muted">
                  Nothing completed yet.
                </Text>
              )}
            </View>
          ) : (
            <>
              <ProposedTasks
                tasks={proposals}
                projects={projects}
                today={today}
                actions={actions}
                highlightIds={highlightIds}
              />
              <View className="pt-1">
                <TaskCard>
                  {backlogFilter !== "recurring" ? addRow("Add to backlog", "backlog") : null}
                  {result.open.length > 0 && backlogFilter !== "recurring" ? (
                    <RowSeparator />
                  ) : null}
                  {renderList(result.open, {
                    trailing: true,
                    reorderable: backlogFilter !== "all",
                  })}
                  {backlogFilter === "recurring"
                    ? renderList(result.recurring, { trailing: true, reorderable: true })
                    : null}
                </TaskCard>
              </View>
              {renderCompleted(allTasks(tasks, backlogFilter).done)}
              {result.recurring.length > 0 && backlogFilter === "all" ? (
                <>
                  <SectionLabel>Recurring</SectionLabel>
                  <TaskCard>
                    {renderList(result.recurring, { trailing: true, reorderable: true })}
                  </TaskCard>
                </>
              ) : null}
            </>
          )}
        </>
      );
      break;
    }
  }

  const filterLabel =
    projectFilter === null
      ? "All projects"
      : projectFilter === "none"
        ? "No project"
        : (projects.find((project) => project.id === projectFilter)?.title ?? "All projects");

  const header = selecting ? (
    <View className="min-h-11 flex-row items-center px-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel selection"
        onPress={() => {
          setSelecting(false);
          setSelectedIds(new Set());
        }}
        className="min-h-11 justify-center px-2"
      >
        <Text className="text-[17px] text-foreground">Cancel</Text>
      </Pressable>
      <Text className="ml-auto px-2 text-[17px] font-t3-bold text-foreground">
        {selectedIds.size} selected
      </Text>
    </View>
  ) : (
    <View className="min-h-11 flex-row items-center px-1">
      <View
        pointerEvents="none"
        className="absolute inset-x-0 top-0 min-h-11 items-center justify-center"
      >
        <Text className="text-[17px] font-t3-bold text-foreground" accessibilityRole="header">
          Tasks
        </Text>
      </View>
      {!usesSplitView ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to Home"
          onPress={() =>
            navigation.canGoBack()
              ? navigation.goBack()
              : navigation.dispatch(StackActions.replace("Home"))
          }
          className="min-h-11 flex-row items-center gap-1 px-2"
        >
          <SymbolView
            name={symbol("chevron.left", "keyboard_arrow_down")}
            size={17}
            tintColorClassName="accent-foreground"
            type="monochrome"
            weight="semibold"
          />
          <Text className="text-[17px] text-foreground">Home</Text>
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            workspace.panes.primarySidebarVisible ? "Hide thread sidebar" : "Show thread sidebar"
          }
          onPress={workspace.togglePrimarySidebar}
          className="size-11 items-center justify-center"
        >
          <SymbolView
            name="sidebar.left"
            size={19}
            tintColorClassName="accent-foreground"
            type="monochrome"
          />
        </Pressable>
      )}
      <View className="ml-auto flex-row items-center">
        <ControlPillMenu
          title={filterLabel}
          actions={[
            {
              id: "all",
              title: "All projects",
              state: projectFilter === null ? "on" : undefined,
            },
            ...selectTaskProjectOptions(projects).map((project) => ({
              id: project.id,
              title: project.title,
              state: projectFilter === project.id ? ("on" as const) : undefined,
            })),
            {
              id: "none",
              title: "No project",
              state: projectFilter === "none" ? "on" : undefined,
            },
          ]}
          onPressAction={({ nativeEvent }) =>
            setProjectFilter(nativeEvent.event === "all" ? null : nativeEvent.event)
          }
        >
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel={`Filter by project, ${filterLabel}`}
            className="size-11 items-center justify-center"
          >
            <SymbolView
              name={symbol(
                projectFilter === null
                  ? "line.3.horizontal.decrease"
                  : "line.3.horizontal.decrease.circle.fill",
                "visibility",
              )}
              size={19}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
          </View>
        </ControlPillMenu>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add a task"
          onPress={() => openQuickAdd(quickAddHorizon)}
          className="size-11 items-center justify-center"
        >
          <SymbolView
            name={symbol("plus", "edit")}
            size={19}
            tintColorClassName="accent-foreground"
            type="monochrome"
          />
        </Pressable>
      </View>
    </View>
  );

  const main = (
    <View className="flex-1">
      <ScrollView
        ref={scrollRef}
        scrollEnabled={!reordering}
        onScroll={(event) => {
          scrollMetrics.current.offset = event.nativeEvent.contentOffset.y;
          if (view === "upcoming") measureDays();
        }}
        onContentSizeChange={(_width, height) => {
          scrollMetrics.current.content = height;
        }}
        onLayout={measureScroll}
        scrollEventThrottle={16}
        refreshControl={
          selecting ? undefined : (
            <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />
          )
        }
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          paddingBottom: insets.bottom + (selecting ? 72 : 48),
          maxWidth: wide ? 640 : undefined,
          width: "100%",
          alignSelf: "center",
        }}
      >
        <View className="px-5 pb-1 pt-2">
          <View className="flex-row items-center">
            <Text
              className="flex-1 text-[32px] font-t3-bold text-foreground"
              accessibilityRole="header"
            >
              {title}
            </Text>
          </View>
          {subtitle !== null ? (
            <Text className="text-[16px] text-foreground-muted">{subtitle}</Text>
          ) : null}
        </View>
        {!available ? (
          <View className="items-center gap-1 px-6 pt-24">
            <Text className="text-center text-[17px] text-foreground-muted">
              Sign in to sync tasks
            </Text>
            <Text className="text-center text-[14px] text-foreground-tertiary">
              Control Plane account
            </Text>
          </View>
        ) : (
          content
        )}
      </ScrollView>
      {selecting ? (
        <SelectionBar
          count={selectedIds.size}
          bottomInset={insets.bottom}
          projects={projects}
          selectedTasks={selectedTasks}
          onMove={() => navigation.navigate("TaskMove", { taskIds: [...selectedIds].join(",") })}
          onHandToAssistant={() => {
            void handToAssistant(selectedTasks);
            setSelecting(false);
            setSelectedIds(new Set());
          }}
          onDelete={() => {
            for (const task of selectedTasks) void actions.delete(task);
            setSelecting(false);
            setSelectedIds(new Set());
          }}
        />
      ) : null}
      <UndoBanner notice={undo.notice} onDismiss={undo.dismiss} bottomOffset={0} />
    </View>
  );

  return (
    <View
      className="flex-1 bg-screen"
      style={{ paddingTop: insets.top }}
      onLayout={(event) => setPaneWidth(event.nativeEvent.layout.width)}
    >
      {header}
      {!wide && !selecting ? (
        <RangeChips
          view={view}
          counts={counts}
          dropHover={dropHover}
          dropLabelFor={(target) => dropLabel(target, today)}
          frames={chipFrames.current}
          onSelect={(next) => {
            setView(next);
            if (next !== "all") setBacklogFilter("all");
          }}
        />
      ) : null}
      {wide ? (
        <View className="flex-1 flex-row">
          <ViewsColumn view={view} counts={counts} onSelect={setView} />
          {main}
        </View>
      ) : (
        <>{main}</>
      )}
    </View>
  );
}

function AddTaskRow(props: { readonly label: string; readonly onPress: () => void }) {
  const palette = useTaskPalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      className="min-h-[52px] flex-row items-center"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View className="size-11 items-center justify-center" style={{ marginLeft: 6 }}>
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 5,
            borderWidth: 1.5,
            borderStyle: "dashed",
            borderColor: palette.dashed,
          }}
        />
      </View>
      <Text className="text-[17px] text-foreground-muted">{props.label}</Text>
    </Pressable>
  );
}

function TextLink(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly align?: "left" | "center";
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      className={cn("min-h-11 justify-center", props.align === "left" ? "px-9 pt-2" : "px-4")}
    >
      <Text className="text-[15px] text-foreground-muted">{props.label}</Text>
    </Pressable>
  );
}

function IntentLine(props: {
  readonly value: string;
  readonly placeholder: string;
  readonly onCommit: (text: string) => void;
}) {
  const [value, setValue] = useState(props.value);
  return (
    <AppTextInput
      accessibilityLabel={props.placeholder}
      style={BARE_INPUT_STYLE}
      className="mt-0.5 min-h-0 rounded-none border-0 bg-transparent p-0 text-[17px] leading-[23px] text-foreground"
      placeholder={props.placeholder}
      value={value}
      maxLength={TASK_INTENT_MAX}
      multiline
      submitBehavior="blurAndSubmit"
      onChangeText={setValue}
      onBlur={() => {
        if (value.trim() !== props.value.trim()) props.onCommit(value.trim());
      }}
    />
  );
}

/** All tasks filters: the backlogs, Recurring, and Completed with its count. */
function BacklogFilters(props: {
  readonly value: TaskBacklogFilter;
  readonly completed: number;
  readonly onChange: (value: TaskBacklogFilter) => void;
}) {
  const entries: ReadonlyArray<{ readonly value: TaskBacklogFilter; readonly label: string }> = [
    { value: "all", label: "All" },
    { value: "week", label: "Week backlog" },
    { value: "month", label: "Month backlog" },
    { value: "year", label: "Year backlog" },
    { value: "recurring", label: "Recurring" },
    { value: "completed", label: `Completed · ${props.completed}` },
  ];
  const palette = useTaskPalette();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 8 }}
    >
      {entries.map((entry) => {
        const active = props.value === entry.value;
        return (
          <Pressable
            key={entry.value}
            accessibilityRole="button"
            accessibilityLabel={`Show ${entry.label}`}
            accessibilityState={{ selected: active }}
            onPress={() => props.onChange(entry.value)}
            style={({ pressed }) => ({
              opacity: pressed ? 0.7 : 1,
              minHeight: 36,
              paddingHorizontal: 14,
              borderRadius: 18,
              justifyContent: "center",
              borderWidth: 1,
              borderColor: active ? "transparent" : palette.dashed,
              backgroundColor: active ? palette.chip : "transparent",
            })}
          >
            <Text
              className={cn(
                "text-[14px]",
                active ? "font-t3-medium text-foreground" : "text-foreground-muted",
              )}
            >
              {entry.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/**
 * One day of Upcoming as a card, the same as desktop: the day, its tasks and
 * an add row. Every day shows, empty or not, so any day can take a drop.
 * While a lifted task from another day hovers it, a dashed outline and a
 * "Move to {day}" label show where it will land.
 */
function DayDropZone(props: {
  readonly date: string;
  readonly title: string;
  /** "Tuesday": the drop label stays short enough for the header. */
  readonly weekday: string;
  readonly offset: string;
  readonly count: number;
  readonly hovering: boolean;
  /** A row of this day is lifted: stack above the other days. */
  readonly lifted: boolean;
  /** Any row is lifted: the card must not clip a row passing over it. */
  readonly dragging: boolean;
  readonly refs: Map<string, View | null>;
  readonly onMeasure: () => void;
  readonly children: ReactNode;
}) {
  const palette = useTaskPalette();
  return (
    <View
      ref={(node) => {
        props.refs.set(props.date, node);
      }}
      // Never let Fabric flatten this view: overflow flips while a row is
      // lifted, and a flattened card re-parents the row mid-gesture, which
      // cancels the drag on iOS (the #110 bug).
      collapsable={false}
      onLayout={props.onMeasure}
      accessibilityLabel={props.hovering ? `Move to ${props.weekday}` : undefined}
      className="mx-4 mt-3 rounded-2xl bg-card"
      style={{
        zIndex: props.lifted ? 50 : 0,
        overflow: props.dragging ? "visible" : "hidden",
        borderWidth: 1.5,
        borderStyle: props.hovering ? "dashed" : "solid",
        borderColor: props.hovering ? palette.accent : "transparent",
      }}
    >
      {props.hovering ? (
        <View
          pointerEvents="none"
          className="absolute inset-0 rounded-2xl"
          style={{ backgroundColor: palette.accent, opacity: 0.07 }}
        />
      ) : null}
      <View className="flex-row items-center gap-2 pl-4 pr-4 pt-3 pb-1">
        <Text className="shrink text-[16px] font-t3-bold text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        <Text className="text-[13px] text-foreground-tertiary">{props.offset}</Text>
        <View className="flex-1" />
        {props.hovering ? (
          <View className="rounded-full px-2.5 py-1" style={{ backgroundColor: palette.accent }}>
            <Text
              className="text-[12px] font-t3-medium"
              style={{ color: palette.accentForeground }}
            >
              {`Move to ${props.weekday}`}
            </Text>
          </View>
        ) : props.count > 0 ? (
          <Text className="text-[13px] tabular-nums text-foreground-tertiary">
            {`${props.count} ${props.count === 1 ? "task" : "tasks"}`}
          </Text>
        ) : null}
      </View>
      {props.children}
    </View>
  );
}

/**
 * The range switcher, the same six ranges as desktop. Today through Year are
 * drop targets: long-press a task, drag it onto a chip, and it moves there.
 */
function RangeChips(props: {
  readonly view: PlanTasksView;
  readonly counts: ReturnType<typeof taskCounts>;
  readonly dropHover: string | null;
  readonly dropLabelFor: (view: PlanTasksView) => string | null;
  readonly frames: Map<string, { x: number; y: number; width: number; height: number }>;
  readonly onSelect: (view: PlanTasksView) => void;
}) {
  const palette = useTaskPalette();
  const refs = useRef(new Map<string, View | null>());
  const measure = () => {
    for (const [view, node] of refs.current) {
      node?.measureInWindow((x, y, width, height) => {
        props.frames.set(view, { x, y, width, height });
      });
    }
  };
  // Only Today carries a count; the periods stay quiet.
  const countFor = (view: PlanTasksView) => (view === "today" ? props.counts.today : 0);
  const hoverLabel =
    props.dropHover === null ? null : props.dropLabelFor(props.dropHover as PlanTasksView);
  const hoverFrame = props.dropHover === null ? undefined : props.frames.get(props.dropHover);
  return (
    <View style={{ zIndex: 20 }}>
      <ScrollView
        horizontal
        accessibilityRole="tablist"
        showsHorizontalScrollIndicator={false}
        onScroll={measure}
        scrollEventThrottle={64}
        onLayout={measure}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 10 }}
      >
        {RANGES.map((range) => {
          const active = props.view === range.view;
          const count = countFor(range.view);
          const hovering = props.dropHover === range.view;
          return (
            <Pressable
              key={range.view}
              ref={(node) => {
                refs.current.set(range.view, node);
              }}
              onLayout={measure}
              accessibilityRole="tab"
              accessibilityLabel={count > 0 ? `${range.label}, ${count}` : range.label}
              accessibilityState={{ selected: active }}
              onPress={() => props.onSelect(range.view)}
              style={({ pressed }) => ({
                opacity: pressed ? 0.7 : 1,
                minHeight: 44,
                paddingHorizontal: 16,
                borderRadius: 22,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                backgroundColor: active ? palette.selectedChip : palette.card,
                borderWidth: 1.5,
                borderStyle: hovering ? "dashed" : "solid",
                borderColor: hovering ? palette.accent : "transparent",
              })}
            >
              <Text
                className={cn("text-[16px] font-t3-medium", !active && "text-foreground")}
                style={active ? { color: palette.selectedChipForeground } : undefined}
              >
                {range.label}
              </Text>
              {count > 0 ? (
                <Text
                  className="text-[14px] tabular-nums"
                  style={{
                    color: active ? palette.selectedChipForeground : palette.mutedForeground,
                    opacity: active ? 0.7 : 1,
                  }}
                >
                  {count}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
      {hoverLabel !== null && hoverFrame !== undefined ? (
        <View
          pointerEvents="none"
          className="absolute rounded-lg px-2.5 py-1.5"
          style={{
            top: 52,
            left: Math.max(8, hoverFrame.x - 24),
            backgroundColor: palette.selectedChip,
          }}
        >
          <Text className="text-[13px]" style={{ color: palette.selectedChipForeground }}>
            {hoverLabel}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function ViewsColumn(props: {
  readonly view: PlanTasksView;
  readonly counts: ReturnType<typeof taskCounts>;
  readonly onSelect: (view: PlanTasksView) => void;
}) {
  const entries: ReadonlyArray<{
    readonly view: PlanTasksView;
    readonly label: string;
    readonly count?: number;
  }> = [
    { view: "today", label: "Today", count: props.counts.today },
    { view: "week", label: "Week", count: props.counts.week },
    { view: "month", label: "Month", count: props.counts.month },
    { view: "year", label: "Year", count: props.counts.year },
  ];
  const item = (entry: { view: PlanTasksView; label: string; count?: number }) => {
    const active = props.view === entry.view;
    return (
      <Pressable
        key={entry.view}
        accessibilityRole="button"
        accessibilityLabel={entry.count ? `${entry.label}, ${entry.count}` : entry.label}
        accessibilityState={{ selected: active }}
        onPress={() => props.onSelect(entry.view)}
        className={cn("min-h-11 flex-row items-center rounded-xl px-3.5", active && "bg-secondary")}
      >
        <Text className={cn("flex-1 text-[17px] text-foreground", active && "font-t3-bold")}>
          {entry.label}
        </Text>
        {entry.count ? (
          <Text className="text-[15px] tabular-nums text-foreground-muted">{entry.count}</Text>
        ) : null}
      </Pressable>
    );
  };
  return (
    <View className="w-[248px] gap-1 border-r border-border px-3 pt-4">
      {entries.map(item)}
      <View className="mx-3 my-2 h-px bg-border" />
      {item({ view: "upcoming", label: "Upcoming" })}
      {item({ view: "all", label: "All tasks" })}
    </View>
  );
}

function SelectionBar(props: {
  readonly count: number;
  readonly bottomInset: number;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly selectedTasks: ReadonlyArray<Task>;
  readonly onMove: () => void;
  readonly onHandToAssistant: () => void;
  readonly onDelete: () => void;
}) {
  const palette = useTaskPalette();
  const hasAssistant = findGlobalAssistantProject(props.projects) !== undefined;
  const disabled = props.count === 0;
  return (
    <View
      className="absolute inset-x-0 bottom-0 flex-row items-center gap-2 border-t border-border bg-screen px-4 pt-3"
      style={{ paddingBottom: Math.max(props.bottomInset, 12) }}
    >
      <BarButton label="Move" icon="calendar" disabled={disabled} onPress={props.onMove} />
      {hasAssistant ? (
        <BarButton
          label="Hand to Assistant"
          disabled={disabled}
          onPress={props.onHandToAssistant}
        />
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Delete ${props.count}`}
        disabled={disabled}
        onPress={props.onDelete}
        className="ml-auto min-h-11 justify-center px-2"
        style={{ opacity: disabled ? 0.4 : 1 }}
      >
        <Text className="text-[17px] font-t3-medium" style={{ color: palette.accent }}>
          Delete {props.count}
        </Text>
      </Pressable>
    </View>
  );
}

function BarButton(props: {
  readonly label: string;
  readonly icon?: Parameters<typeof symbol>[0];
  readonly disabled?: boolean;
  readonly onPress?: () => void;
}) {
  const palette = useTaskPalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => ({
        opacity: props.disabled ? 0.4 : pressed ? 0.7 : 1,
        minHeight: 44,
        paddingHorizontal: 16,
        borderRadius: 22,
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        backgroundColor: palette.chip,
      })}
    >
      {props.icon !== undefined ? (
        <SymbolView
          name={symbol(props.icon, "build")}
          size={15}
          tintColorClassName="accent-foreground"
          type="monochrome"
        />
      ) : null}
      <Text className="text-[16px] font-t3-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}
