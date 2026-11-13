import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
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
  proposedTasks,
  taskAgentState,
  taskCounts,
  taskIntentFor,
  todayTasks,
  upcomingTasks,
  type TaskBacklogFilter,
  type TaskLifecycleProject,
} from "@t3tools/client-runtime/state/projects";
import {
  taskPeriodFor,
  TASK_INTENT_MAX,
  type ProjectStatus,
  type Task,
  type TaskHorizon,
  type ThreadId,
} from "@t3tools/contracts";
import { Fragment, useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View, useWindowDimensions } from "react-native";
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
import { ProposedTasks } from "./ProposedTasks";
import { projectForTask, useHandToAgent } from "./taskHandoff";
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
import { useMobileTaskStore, useTaskToday } from "./useMobileTasks";

// Fork-owned. Personal tasks on phone and iPad: Today, Week, Month, Year and
// all Tasks, with select mode, Move, quick add and hand to agent. Named
// "Plan" in code so it is never confused with the thread list's old "tasks".

export type PlanTasksView = "today" | TaskHorizon | "upcoming" | "all";

type PlanTasksParams = { readonly view?: PlanTasksView } | undefined;

const TABS: ReadonlyArray<{ readonly view: PlanTasksView; readonly label: string }> = [
  { view: "today", label: "Today" },
  { view: "week", label: "Week" },
  { view: "month", label: "Month" },
  { view: "year", label: "Year" },
  { view: "all", label: "Tasks" },
];

const WIDE_LAYOUT_MIN_WIDTH = 700;
const TAB_BAR_HEIGHT = 50;

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
  const { tasks, intents, projects, actions, available } = useMobileTaskStore();
  const threads = useThreadShells();
  const handToAgent = useHandToAgent();
  const undo = useUndoNotice();
  const showUndo = undo.show;
  const palette = useTaskPalette();

  const [view, setView] = useState<PlanTasksView>(route.params?.view ?? "today");
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>(null);
  const [backlogFilter, setBacklogFilter] = useState<TaskBacklogFilter>("all");
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [showCompleted, setShowCompleted] = useState(false);

  const openThread = useCallback(
    (project: EnvironmentProject, threadId: ThreadId) => {
      const params = { environmentId: String(project.environmentId), threadId: String(threadId) };
      if (usesSplitView) navigation.navigate("Thread", params);
      else navigation.dispatch(StackActions.push("Thread", params));
    },
    [navigation, usesSplitView],
  );

  const context: PlanTaskRowContext = useMemo(
    () => ({
      today,
      actions,
      projects,
      onComplete: (task: Task) => {
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
      onHandToAgent: (task: Task, kind: "coordinator" | "agent", project: EnvironmentProject) =>
        void handToAgent([task], kind, project),
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
    [actions, handToAgent, navigation, openThread, projects, showUndo, today],
  );

  const lifecycleProjects = projects as ReadonlyArray<TaskLifecycleProject>;
  const visible = useCallback(
    (list: ReadonlyArray<Task>) => {
      const scoped = filterTasksByProject(list, projectFilter);
      const needle = query.trim().toLowerCase();
      return needle.length === 0
        ? scoped
        : scoped.filter(
            (task) =>
              task.title.toLowerCase().includes(needle) ||
              (task.notes ?? "").toLowerCase().includes(needle),
          );
    },
    [projectFilter, query],
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

  const renderList = (
    list: ReadonlyArray<Task>,
    options?: { hidePeriod?: boolean; trailing?: boolean },
  ) =>
    list.map((task, index) => (
      <Fragment key={task.id}>
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
          metaPlacement={options?.trailing ? "trailing" : "below"}
        />
      </Fragment>
    ));

  const openQuickAdd = (horizon: "today" | TaskHorizon | "backlog") =>
    navigation.navigate("TaskQuickAdd", {
      horizon,
      ...(projectFilter !== null && projectFilter !== "none" ? { projectId: projectFilter } : {}),
    });

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
      const open = visible(todayTasks(tasks, today));
      const proposals = visible(proposedTasks(tasks));
      const done = visible(completedToday(tasks, today));
      content = (
        <>
          <ProposedTasks
            tasks={proposals}
            projects={projects}
            today={today}
            actions={actions}
            variant="list"
          />
          {open.length === 0 && proposals.length === 0 ? (
            <>
              <View className="pt-4">
                <TaskCard>{addRow("Add a task", "today")}</TaskCard>
              </View>
              <View className="items-center gap-1 pt-28">
                <Text className="pb-3 text-[17px] text-foreground-muted">
                  Nothing on today's plate.
                </Text>
                <TextLink label="View upcoming tasks" onPress={() => setView("upcoming")} />
                <TextLink label="View all tasks" onPress={() => setView("all")} />
              </View>
            </>
          ) : (
            <>
              <SectionLabel>Today</SectionLabel>
              <TaskCard>
                {renderList(open, { hidePeriod: false })}
                {open.length > 0 ? <RowSeparator /> : null}
                {addRow("Add a task", "today")}
              </TaskCard>
            </>
          )}
          {done.length > 0 ? (
            <>
              <TextLink
                label={showCompleted ? "Hide completed" : `Show completed · ${done.length}`}
                onPress={() => setShowCompleted((value) => !value)}
                align="left"
              />
              {showCompleted ? <TaskCard>{renderList(done)}</TaskCard> : null}
            </>
          ) : null}
        </>
      );
      break;
    }
    case "week":
    case "month":
    case "year": {
      const period = taskPeriodFor(view, today);
      title =
        view === "week"
          ? `Week of ${formatTaskShortDate(period.startsOn)}`
          : formatTaskPeriodTitle(view, period.startsOn);
      subtitle = formatTaskRange(period.startsOn, period.endsOn);
      const committed = visible(committedTasks(tasks, view, today));
      const backlog = backlogTasks(tasks, view).length;
      const intent = taskIntentFor(intents, view, today);
      content = (
        <>
          <IntentLine
            key={`${view}:${period.startsOn}:${intent?.text ?? ""}`}
            value={intent?.text ?? ""}
            placeholder={`Set this ${view}'s intent`}
            onCommit={(text) => void actions.setIntent(view, period.startsOn, text)}
          />
          <SectionLabel>Committed</SectionLabel>
          <TaskCard>
            {renderList(committed, { hidePeriod: true })}
            {committed.length > 0 ? <RowSeparator /> : null}
            {addRow("Add a commitment", view)}
          </TaskCard>
          {backlog > 0 ? (
            <TextLink
              label={`${view[0]!.toUpperCase()}${view.slice(1)} backlog · ${backlog}`}
              align="left"
              onPress={() => {
                setBacklogFilter(view);
                setView("all");
              }}
            />
          ) : null}
        </>
      );
      break;
    }
    case "upcoming": {
      title = "Upcoming";
      subtitle = "Next 7 days";
      const groups = upcomingTasks(tasks, today).map((group) => ({
        ...group,
        tasks: visible(group.tasks),
      }));
      content = (
        <>
          {groups.map((group) => (
            <Fragment key={group.date}>
              <SectionLabel
                trailing={
                  <Text className="text-[13px] text-foreground-tertiary">
                    {formatUpcomingOffset(group.date, today)}
                  </Text>
                }
              >
                {formatTaskDayTitle(group.date)}
              </SectionLabel>
              {group.tasks.length > 0 ? (
                <TaskCard>{renderList(group.tasks)}</TaskCard>
              ) : (
                <Text className="px-9 text-[14px] text-foreground-tertiary">Nothing yet</Text>
              )}
            </Fragment>
          ))}
        </>
      );
      break;
    }
    case "all": {
      title = "Tasks";
      const result = allTasks(visible(tasks), backlogFilter);
      content = (
        <>
          <ProjectChips
            projects={projects}
            value={projectFilter}
            onChange={setProjectFilter}
            backlogFilter={backlogFilter}
            onClearBacklog={() => setBacklogFilter("all")}
          />
          <View className="pt-1">
            <TaskCard>
              {addRow("Add a task", "backlog")}
              {result.open.length > 0 ? <RowSeparator /> : null}
              {renderList(result.open, { trailing: true })}
            </TaskCard>
          </View>
          {result.recurring.length > 0 ? (
            <>
              <SectionLabel>Recurring</SectionLabel>
              <TaskCard>{renderList(result.recurring, { trailing: true })}</TaskCard>
            </>
          ) : null}
          {result.completed > 0 ? (
            <Text className="px-9 pt-5 text-[14px] text-foreground-muted">
              Completed · {result.completed}
            </Text>
          ) : null}
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
        {view !== "all" ? (
          <ControlPillMenu
            title={filterLabel}
            actions={[
              {
                id: "all",
                title: "All projects",
                state: projectFilter === null ? "on" : undefined,
              },
              ...projects
                .filter((project) => project.assistant != null)
                .map((project) => ({
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
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={searching ? "Close search" : "Search tasks"}
          onPress={() => {
            setSearching((open) => !open);
            setQuery("");
          }}
          className="size-11 items-center justify-center"
        >
          <SymbolView
            name={symbol(searching ? "xmark" : "magnifyingglass", "close")}
            size={18}
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
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          paddingBottom: (wide ? 24 : TAB_BAR_HEIGHT) + insets.bottom + (selecting ? 72 : 48),
          maxWidth: wide ? 640 : undefined,
          width: "100%",
          alignSelf: "center",
        }}
      >
        <View className="px-5 pb-1 pt-2">
          <Text className="text-[32px] font-t3-bold text-foreground" accessibilityRole="header">
            {title}
          </Text>
          {subtitle !== null ? (
            <Text className="text-[16px] text-foreground-muted">{subtitle}</Text>
          ) : null}
        </View>
        {searching ? (
          <View className="px-4 pt-2">
            <AppTextInput
              accessibilityLabel="Search tasks"
              autoFocus
              className="min-h-11 rounded-full border-0 bg-card px-4 py-2 text-[16px]"
              placeholder="Search tasks"
              returnKeyType="search"
              value={query}
              onChangeText={setQuery}
            />
          </View>
        ) : null}
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
          onHandToAgent={(kind, project) => {
            void handToAgent(selectedTasks, kind, project);
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
      <UndoBanner
        notice={undo.notice}
        onDismiss={undo.dismiss}
        bottomOffset={wide || selecting ? 0 : TAB_BAR_HEIGHT}
      />
    </View>
  );

  return (
    <View
      className="flex-1 bg-screen"
      style={{ paddingTop: insets.top }}
      onLayout={(event) => setPaneWidth(event.nativeEvent.layout.width)}
    >
      {header}
      {wide ? (
        <View className="flex-1 flex-row">
          <ViewsColumn
            view={view}
            counts={counts}
            onSelect={(next) => {
              setView(next);
              setExpandedId(null);
            }}
          />
          {main}
        </View>
      ) : (
        <>
          {main}
          {!selecting ? (
            <TabBar
              view={view}
              accent={palette.accent}
              bottomInset={insets.bottom}
              onSelect={(next) => {
                setView(next);
                setExpandedId(null);
                if (next !== "all") setBacklogFilter("all");
              }}
            />
          ) : null}
        </>
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
      className="mx-5 mt-2 min-h-0 rounded-none border-0 bg-transparent p-0 text-[17px] leading-[23px] text-foreground"
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

function ProjectChips(props: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly value: ProjectFilter;
  readonly onChange: (value: ProjectFilter) => void;
  readonly backlogFilter: TaskBacklogFilter;
  readonly onClearBacklog: () => void;
}) {
  const palette = useTaskPalette();
  const chip = (id: ProjectFilter, label: string, leading?: ReactNode) => {
    const active = props.value === id;
    return (
      <Pressable
        key={id ?? "all"}
        accessibilityRole="button"
        accessibilityLabel={`Show ${label}`}
        accessibilityState={{ selected: active }}
        onPress={() => props.onChange(id)}
        style={({ pressed }) => ({
          opacity: pressed ? 0.7 : 1,
          minHeight: 40,
          paddingHorizontal: 16,
          borderRadius: 20,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          backgroundColor: active ? palette.accent : palette.chip,
        })}
      >
        {leading}
        <Text
          className={cn("text-[15px] font-t3-medium", !active && "text-foreground")}
          style={active ? { color: palette.accentForeground } : undefined}
        >
          {label}
        </Text>
      </Pressable>
    );
  };
  const backlogLabel =
    props.backlogFilter === "all"
      ? null
      : props.backlogFilter === "recurring"
        ? "Recurring"
        : `${props.backlogFilter[0]!.toUpperCase()}${props.backlogFilter.slice(1)} backlog`;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 12 }}
    >
      {chip(null, "All")}
      {props.projects
        .filter((project) => project.assistant != null)
        .map((project) => chip(project.id, project.title))}
      {chip("none", "No project")}
      {backlogLabel !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Clear filter ${backlogLabel}`}
          onPress={props.onClearBacklog}
          style={{
            minHeight: 40,
            paddingHorizontal: 14,
            borderRadius: 20,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            borderWidth: 1,
            borderColor: palette.dashed,
          }}
        >
          <Text className="text-[15px] text-foreground">{backlogLabel}</Text>
          <SymbolView
            name={symbol("xmark", "close")}
            size={11}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

function tabIcon(view: PlanTasksView) {
  return view === "all" ? symbol("checklist", "check") : symbol("calendar", "folder");
}

function TabBar(props: {
  readonly view: PlanTasksView;
  readonly accent: string;
  readonly bottomInset: number;
  readonly onSelect: (view: PlanTasksView) => void;
}) {
  return (
    <View
      accessibilityRole="tablist"
      className="flex-row border-t border-border bg-screen"
      style={{ paddingBottom: Math.max(props.bottomInset, 8) }}
    >
      {TABS.map((tab) => {
        const active = props.view === tab.view;
        return (
          <Pressable
            key={tab.view}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: active }}
            onPress={() => props.onSelect(tab.view)}
            className="flex-1 items-center justify-center gap-1 pt-2"
            style={{ minHeight: TAB_BAR_HEIGHT }}
          >
            <SymbolView
              name={tabIcon(tab.view)}
              size={20}
              tintColorClassName={active ? "accent-foreground" : "accent-icon-muted"}
              type="monochrome"
              weight={active ? "semibold" : "regular"}
            />
            <Text
              className={cn(
                "text-[11px]",
                active ? "font-t3-bold text-foreground" : "text-foreground-muted",
              )}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
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
  readonly onHandToAgent: (kind: "coordinator" | "agent", project: EnvironmentProject) => void;
  readonly onDelete: () => void;
}) {
  const palette = useTaskPalette();
  const owners = new Set(
    props.selectedTasks.map((task) => projectForTask(task, props.projects)?.id ?? null),
  );
  const project =
    owners.size === 1 ? projectForTask(props.selectedTasks[0]!, props.projects) : null;
  const handOffProjects =
    project !== null && project.assistant != null
      ? [project]
      : props.projects.filter((candidate) => candidate.assistant != null);
  const disabled = props.count === 0;
  return (
    <View
      className="absolute inset-x-0 bottom-0 flex-row items-center gap-2 border-t border-border bg-screen px-4 pt-3"
      style={{ paddingBottom: Math.max(props.bottomInset, 12) }}
    >
      <BarButton label="Move" icon="calendar" disabled={disabled} onPress={props.onMove} />
      <ControlPillMenu
        actions={handOffProjects.flatMap((candidate) => [
          { id: `coordinator:${candidate.id}`, title: `Ask ${candidate.title} coordinator` },
          { id: `agent:${candidate.id}`, title: `Start an agent in ${candidate.title}` },
        ])}
        onPressAction={({ nativeEvent }) => {
          const [kind, id] = nativeEvent.event.split(":");
          const target = props.projects.find((candidate) => candidate.id === id);
          if (target !== undefined && !disabled) {
            props.onHandToAgent(kind === "agent" ? "agent" : "coordinator", target);
          }
        }}
      >
        <BarButton label="Hand to agent" icon="cpu" disabled={disabled} />
      </ControlPillMenu>
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
  readonly icon: Parameters<typeof symbol>[0];
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
      <SymbolView
        name={symbol(props.icon, "build")}
        size={15}
        tintColorClassName="accent-foreground"
        type="monochrome"
      />
      <Text className="text-[16px] font-t3-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}
