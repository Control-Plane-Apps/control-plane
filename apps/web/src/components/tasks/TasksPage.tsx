import { useTasksKeyboard } from "./useTasksKeyboard";
import {
  allTasks,
  backlogTasks,
  committedTasks,
  completedToday,
  filterTasksByProject,
  formatTaskDayTitle,
  formatTaskPeriodTitle,
  formatTaskRange,
  formatUpcomingOffset,
  decodeTaskHighlight,
  proposedTasksForView,
  proposedTasksOnDate,
  taskCounts,
  taskIntentFor,
  todayTasks,
  upcomingTasks,
  dayDropHome,
  homeForMove,
  type TaskBacklogFilter,
  type TaskLifecycleThread,
} from "@t3tools/client-runtime/state/projects";
import {
  findGlobalAssistantProject,
  taskPeriodFor,
  type Task,
  type TaskHome,
  type TaskHorizon,
  type TaskIntent,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, ListFilterIcon, PlusIcon } from "lucide-react";
import { useDroppable } from "@dnd-kit/core";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  taskRangeCommandForIndex,
  taskRangeIndexFromCommand,
} from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { cn } from "../../lib/utils";
import { useProjects, useThreadShells } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useTaskEnvironmentStatus, useTaskToday, useTasks } from "../../state/tasks";
import { useTaskSync } from "../../state/taskSync";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Kbd } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useHandToAgent } from "./handToAgent";
import { openTaskQuickAdd } from "./QuickAddDialog";
import {
  AddTaskRow,
  ProposedTasks,
  TaskDragPreview,
  TaskList,
  TasksSectionLabel,
  useExpandedTask,
} from "./TaskList";
import { TASK_RANGE_DROP, TaskDayDropZone, TaskDragProvider } from "./taskDrag";
import type { TaskRowContext } from "./TaskRow";
import { TaskSyncChip, TaskSyncMarginLine, taskSyncIndicator } from "./TaskSyncIndicator";
import {
  defaultHomeForView,
  dropLabelForView,
  dropTargetForView,
  TASK_VIEW_LABEL as VIEW_LABEL,
  TASK_VIEWS,
  type TasksSearch,
  type TasksView,
} from "./tasksRange";
import { useOptimisticTaskHomes } from "./useOptimisticTaskHomes";
import { useTaskSelection } from "./useTaskSelection";
import { TaskMoveMenu } from "./TaskMenus";
import { useTaskActions } from "./useTaskActions";

export { TASK_VIEWS, type TasksSearch, type TasksView } from "./tasksRange";

/** Search params with cleared keys left out, so URLs stay short. */
function tasksSearch(search: TasksSearch, patch: TasksSearch): TasksSearch {
  const next = { ...search, ...patch };
  return {
    ...(next.project !== undefined ? { project: next.project } : {}),
    ...(next.filter !== undefined ? { filter: next.filter } : {}),
  };
}

function ProjectFilterMenu(props: {
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
}) {
  const projects = useProjects().filter((project) => project.assistant != null);
  const selected =
    props.value === "none"
      ? "No project"
      : (projects.find((project) => project.id === props.value)?.title ?? "All projects");
  const item = (value: string | null, label: string) => (
    <MenuItem key={value ?? "all"} onClick={() => props.onChange(value)}>
      <span className="flex w-full items-center gap-2">
        <CheckIcon
          aria-hidden
          className={cn("size-3.5", props.value === value ? "opacity-100" : "opacity-0")}
        />
        {label}
      </span>
    </MenuItem>
  );
  return (
    <Menu>
      <MenuTrigger className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs hover:bg-accent">
        <ListFilterIcon aria-hidden className="size-3.5 text-muted-foreground" />
        {selected}
        <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="end" className="w-48">
        {item(null, "All projects")}
        <MenuSeparator />
        {projects.map((project) => item(project.id, project.title))}
        {item("none", "No project")}
      </MenuPopup>
    </Menu>
  );
}

function IntentEditor(props: {
  readonly intent: TaskIntent | undefined;
  readonly placeholder: string;
  readonly className?: string;
  readonly onSave: (text: string) => void;
}) {
  // Keyed on the stored text by callers, so a remote edit resets it.
  const [value, setValue] = useState(props.intent?.text ?? "");
  return (
    <textarea
      aria-label={props.placeholder}
      placeholder={props.placeholder}
      rows={1}
      maxLength={80}
      className={cn(
        "w-full resize-none bg-transparent outline-none [field-sizing:content] placeholder:text-muted-foreground/60",
        props.className,
      )}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      onBlur={() => {
        if (value.trim() !== (props.intent?.text ?? "")) props.onSave(value);
      }}
    />
  );
}

function AsideSection(props: { readonly title?: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      {props.title !== undefined ? (
        <h3 className="text-muted-foreground text-xs">{props.title}</h3>
      ) : null}
      {props.children}
    </section>
  );
}

/**
 * Today, Week, Month, Year, then Upcoming and All tasks: one switcher at the
 * top of the view. The first four are drop targets, so dragging a task onto a
 * tab moves its home; Ctrl+1 to Ctrl+6 switch while the view is open.
 */
function RangeTabs(props: {
  readonly view: TasksView;
  readonly today: string;
  /** Open today, the only count the switcher shows. */
  readonly todayCount: number;
  readonly shortcutFor: (index: number) => string | null;
  readonly onSelect: (view: TasksView) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Task ranges"
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/70 p-0.5"
    >
      {TASK_VIEWS.map((entry, index) => (
        <span key={entry} className="contents">
          {entry === "upcoming" ? (
            <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
          ) : null}
          <RangeTab
            entry={entry}
            selected={entry === props.view}
            today={props.today}
            count={entry === "today" ? props.todayCount : 0}
            shortcut={props.shortcutFor(index)}
            onSelect={() => props.onSelect(entry)}
          />
        </span>
      ))}
    </div>
  );
}

/** One range tab; Today, Week, Month and Year take dragged tasks (TaskDragProvider). */
function RangeTab(props: {
  readonly entry: TasksView;
  readonly selected: boolean;
  readonly today: string;
  readonly count: number;
  readonly shortcut: string | null;
  readonly onSelect: () => void;
}) {
  const { entry } = props;
  const { setNodeRef, isOver: dropping } = useDroppable({
    id: `${TASK_RANGE_DROP}:${entry}`,
    data: { type: TASK_RANGE_DROP, view: entry },
    disabled: dropTargetForView(entry) === null,
  });
  const tooltip = dropping
    ? dropLabelForView(entry, props.today)
    : props.shortcut !== null
      ? `${VIEW_LABEL[entry]} ${props.shortcut}`
      : null;
  const tab = (
    <button
      ref={setNodeRef}
      type="button"
      role="tab"
      aria-selected={props.selected}
      className={cn(
        "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-transparent px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
        props.selected
          ? "bg-background font-medium text-foreground shadow-xs"
          : "text-muted-foreground hover:text-foreground",
        dropping && "border-primary border-dashed",
      )}
      onClick={props.onSelect}
    >
      {VIEW_LABEL[entry]}
      {props.count > 0 ? (
        <span className="text-muted-foreground text-xs tabular-nums">{props.count}</span>
      ) : null}
    </button>
  );
  return tooltip !== null ? (
    <Tooltip open={dropping ? true : undefined}>
      <TooltipTrigger render={tab} />
      <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
    </Tooltip>
  ) : (
    tab
  );
}

export function TasksPage(props: { readonly view: TasksView; readonly search: TasksSearch }) {
  const { view, search } = props;
  const navigate = useNavigate();
  const today = useTaskToday();
  const { environmentId, tasks: serverTaskRecords, intents } = useTasks();
  const taskEnvironmentStatus = useTaskEnvironmentStatus();
  const projects = useProjects();
  const threads = useThreadShells() as ReadonlyArray<TaskLifecycleThread>;
  const actions = useTaskActions(environmentId);
  const { tasks: allTaskRecords, move: moveTask } = useOptimisticTaskHomes(
    serverTaskRecords,
    actions,
  );
  const handToAgent = useHandToAgent();
  const sync = taskSyncIndicator(useTaskSync().status);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const quickAddShortcut = shortcutLabelForCommand(keybindings, "tasks.quickAdd");
  const { expandedId, toggle } = useExpandedTask();
  const [showCompleted, setShowCompleted] = useState(false);
  const projectFilter = search.project ?? null;
  const tasks = useMemo(
    () => filterTasksByProject(allTaskRecords, projectFilter),
    [allTaskRecords, projectFilter],
  );
  const visibleTasks = useMemo(() => {
    if (view === "today")
      return [...todayTasks(tasks, today), ...(showCompleted ? completedToday(tasks, today) : [])];
    if (view === "week" || view === "month" || view === "year")
      return committedTasks(tasks, view, today);
    if (view === "upcoming") return upcomingTasks(tasks, today).flatMap((group) => group.tasks);
    const result = allTasks(tasks, search.filter ?? "all");
    return search.filter === "completed" ? result.done : [...result.open, ...result.recurring];
  }, [tasks, today, view, showCompleted, search.filter]);
  const orderedIds = useMemo(() => visibleTasks.map((task) => task.id as string), [visibleTasks]);
  const selection = useTaskSelection(orderedIds);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [moveRequest, setMoveRequest] = useState<{ id: string; sequence: number } | null>(null);
  const selectedTasks = visibleTasks.filter((task) => selection.selectedIds.has(task.id));
  const deleteSelection = () => {
    for (const task of selectedTasks) void actions.delete(task);
  };
  useTasksKeyboard({
    expandedId,
    selectedIds: selectedTasks.map((task) => task.id),
    hoveredId,
    orderedIds,
    isBlocked: isCommandPaletteOpen,
    onExpand: toggle,
    onClear: selection.clear,
    onDelete: deleteSelection,
    onNew: openTaskQuickAdd,
    onMove: (id) => setMoveRequest((current) => ({ id, sequence: (current?.sequence ?? 0) + 1 })),
  });
  const counts = taskCounts(tasks, today);
  const context: TaskRowContext = {
    today,
    actions,
    projects,
    onHandToAgent: (task, kind, project) => void handToAgent(task, kind, project),
  };
  const add = (home: TaskHome) => (title: string) =>
    actions.create({
      title,
      home,
      ...(projectFilter !== null && projectFilter !== "none"
        ? { links: { projectId: projectFilter as never } }
        : {}),
    });
  const goTo = (next: TasksView, patch: TasksSearch = {}) =>
    void navigate({
      to: "/tasks/$view",
      params: { view: next },
      search: tasksSearch({ ...search, filter: undefined }, patch),
    });
  const setFilter = (project: string | null) =>
    void navigate({
      to: "/tasks/$view",
      params: { view },
      search: tasksSearch(search, { project: project ?? undefined }),
    });

  // Ctrl+1 to Ctrl+6 (Alt elsewhere than a Mac) switch ranges while Tasks is
  // open. They are their own commands, so a remapped binding still works and
  // Cmd+1 and Cmd+2 stay the global Assistant and Tasks shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      const index = taskRangeIndexFromCommand(command ?? "");
      const next = index === null ? undefined : TASK_VIEWS[index];
      if (next === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      void navigate({
        to: "/tasks/$view",
        params: { view: next },
        search: projectFilter === null ? {} : { project: projectFilter },
      });
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [keybindings, navigate, projectFilter]);

  // Opened from a chat's proposal block: scroll to those rows and light them
  // up briefly, then drop the param so a reload does not replay it.
  const highlight = search.highlight;
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const ids = decodeTaskHighlight(highlight);
    const root = mainRef.current;
    if (ids.length === 0 || root === null) return;
    const rows = ids.flatMap((id) => [
      ...root.querySelectorAll<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`),
    ]);
    rows[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
    for (const row of rows) row.dataset.highlighted = "true";
    const timer = window.setTimeout(() => {
      for (const row of rows) delete row.dataset.highlighted;
      void navigate({
        to: "/tasks/$view",
        params: { view },
        search: tasksSearch(search, {}),
        replace: true,
      });
    }, 2400);
    return () => {
      window.clearTimeout(timer);
      for (const row of rows) delete row.dataset.highlighted;
    };
    // Runs once per highlight request, not on every search change.
  }, [highlight, view]);

  const shortcutFor = (index: number) => {
    const command = taskRangeCommandForIndex(index);
    return command === null ? null : shortcutLabelForCommand(keybindings, command);
  };

  const onDropOnRange = (task: Task, target: string) => {
    const move = dropTargetForView(target as TasksView);
    if (move === null) return;
    void moveTask(task, homeForMove(move, task.home, today));
  };

  const onDropOnDay = (task: Task, date: string) => {
    const home = dayDropHome(task, date, today);
    if (home !== null) void moveTask(task, home);
  };

  const list = (
    items: ReadonlyArray<Task>,
    label: string,
    reorderable = true,
    hidePeriod = false,
  ) => (
    <TaskList
      tasks={items}
      context={context}
      threads={threads}
      expandedId={expandedId}
      onToggle={toggle}
      selectedIds={selection.selectedIds}
      onSelectClick={(id, event) => {
        if (
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          selection.selectedIds.size > 1 &&
          selection.selectedIds.has(id)
        )
          return;
        selection.handleRowClick(id, event);
      }}
      onHover={setHoveredId}
      moveRequest={moveRequest}
      reorderable={reorderable}
      hidePeriod={hidePeriod}
      label={label}
    />
  );

  const weekIntent = taskIntentFor(intents, "week", today);
  const saveIntent = (horizon: TaskHorizon) => (text: string) =>
    void actions.setIntent(horizon, taskPeriodFor(horizon, today).startsOn, text);
  const syncLine = <TaskSyncMarginLine indicator={sync} />;

  let body: ReactNode;
  let aside: ReactNode = null;
  if (environmentId === null) {
    body = (
      <p className="pt-10 text-muted-foreground text-sm">
        Tasks need a Control Plane server that supports them. Update this Mac's server, or connect
        to one that has your Tasks.
      </p>
    );
  } else if (view === "today") {
    const open = todayTasks(tasks, today);
    const done = completedToday(tasks, today);
    const proposals = proposedTasksForView(tasks, "today", today);
    const firstRun = allTaskRecords.length === 0;
    if (firstRun) {
      body = (
        <div className="mx-auto flex max-w-sm flex-col pt-[22vh]">
          <h1 className="font-semibold text-2xl">{formatTaskDayTitle(today)}</h1>
          <div className="pt-4">
            <AddTaskRow onAdd={add({ kind: "date", date: today })} />
          </div>
          {quickAddShortcut ? (
            <p className="flex items-center gap-2 pt-3 text-muted-foreground text-sm">
              <Kbd>{quickAddShortcut}</Kbd> from anywhere
            </p>
          ) : null}
        </div>
      );
    } else {
      body = (
        <>
          <h1 className="font-semibold text-2xl">{formatTaskDayTitle(today)}</h1>
          {proposals.length > 0 ? (
            <div className="pt-5">
              <ProposedTasks tasks={proposals} context={context} />
            </div>
          ) : null}
          <div className="pt-4">
            {open.length === 0 && proposals.length === 0 ? (
              <p className="py-6 text-muted-foreground text-sm">Nothing on today's plate.</p>
            ) : null}
            {list(open, "Today")}
            <AddTaskRow onAdd={add({ kind: "date", date: today })} />
            {done.length > 0 ? (
              <>
                <button
                  type="button"
                  className="mt-3 cursor-pointer text-muted-foreground text-xs hover:text-foreground"
                  onClick={() => setShowCompleted((value) => !value)}
                >
                  {showCompleted ? "Hide completed" : `Show completed · ${done.length}`}
                </button>
                {showCompleted ? list(done, "Completed today", false) : null}
              </>
            ) : null}
          </div>
        </>
      );
      aside = (
        <>
          <AsideSection title="This week's intent">
            <IntentEditor
              key={weekIntent?.text ?? ""}
              intent={weekIntent}
              placeholder="Set this week's intent"
              className="text-sm"
              onSave={saveIntent("week")}
            />
          </AsideSection>
          {syncLine}
        </>
      );
    }
  } else if (view === "week" || view === "month" || view === "year") {
    const horizon: TaskHorizon = view;
    const period = taskPeriodFor(horizon, today);
    const committed = committedTasks(tasks, horizon, today);
    const backlog = backlogTasks(tasks, horizon);
    const proposedHere = proposedTasksForView(tasks, horizon, today);
    const intent = taskIntentFor(intents, horizon, today);
    const parent: TaskHorizon | null =
      horizon === "week" ? "month" : horizon === "month" ? "year" : null;
    body = (
      <>
        <h1 className="font-semibold text-2xl">
          {formatTaskPeriodTitle(horizon, period.startsOn)}
        </h1>
        <p className="pt-1 text-muted-foreground text-sm">
          {formatTaskRange(period.startsOn, period.endsOn)}
        </p>
        <IntentEditor
          key={`${period.startsOn}:${intent?.text ?? ""}`}
          intent={intent}
          placeholder={`Set this ${horizon}'s intent`}
          className="pt-4 text-[15px]"
          onSave={saveIntent(horizon)}
        />
        {proposedHere.length > 0 ? (
          <div className="pt-5">
            <ProposedTasks tasks={proposedHere} context={context} />
          </div>
        ) : null}
        <TasksSectionLabel>Committed</TasksSectionLabel>
        {list(committed, "Committed", true, true)}
        <AddTaskRow label="Add a commitment" onAdd={add({ kind: "period", horizon, ...period })} />
      </>
    );
    aside = (
      <>
        {parent !== null ? (
          <AsideSection title={`This ${parent}'s intent`}>
            <IntentEditor
              key={taskIntentFor(intents, parent, today)?.text ?? ""}
              intent={taskIntentFor(intents, parent, today)}
              placeholder={`Set this ${parent}'s intent`}
              className="text-sm"
              onSave={saveIntent(parent)}
            />
          </AsideSection>
        ) : null}
        <AsideSection>
          <Link
            to="/tasks/$view"
            params={{ view: "all" }}
            search={{ filter: horizon }}
            className="py-0.5 text-muted-foreground text-sm hover:text-foreground"
          >
            {VIEW_LABEL[view]} backlog · {backlog.length}
          </Link>
        </AsideSection>
        {syncLine}
      </>
    );
  } else if (view === "upcoming") {
    const groups = upcomingTasks(tasks, today);
    body = (
      <>
        <h1 className="font-semibold text-2xl">Upcoming</h1>
        <p className="pt-1 text-muted-foreground text-sm">Next 7 days</p>
        <div className="flex flex-col gap-3 pt-5">
          {groups.map((group) => {
            const proposedThatDay = proposedTasksOnDate(tasks, group.date);
            return (
              <TaskDayDropZone
                key={group.date}
                date={group.date}
                label={formatTaskDayTitle(group.date)}
                className="overflow-hidden rounded-xl border border-border bg-card px-4 pt-3 pb-1 transition-colors data-[day-drop-over=true]:border-primary data-[day-drop-over=true]:border-dashed data-[day-drop-over=true]:bg-primary/5"
              >
                <div className="flex items-baseline gap-2 pb-1">
                  <h2 className="font-semibold text-[15px]">{formatTaskDayTitle(group.date)}</h2>
                  <span className="text-muted-foreground text-xs">
                    {formatUpcomingOffset(group.date, today)}
                  </span>
                  <span className="ms-auto text-muted-foreground text-xs">
                    {group.tasks.length === 0
                      ? ""
                      : `${group.tasks.length} ${group.tasks.length === 1 ? "task" : "tasks"}`}
                  </span>
                </div>
                {proposedThatDay.length > 0 ? (
                  <div className="pt-1 pb-1.5">
                    <ProposedTasks tasks={proposedThatDay} context={context} />
                  </div>
                ) : null}
                {list(group.tasks, formatTaskDayTitle(group.date), true, true)}
                <AddTaskRow onAdd={add({ kind: "date", date: group.date })} />
              </TaskDayDropZone>
            );
          })}
        </div>
      </>
    );
    aside = (
      <>
        <AsideSection title="This week's intent">
          <IntentEditor
            key={weekIntent?.text ?? ""}
            intent={weekIntent}
            placeholder="Set this week's intent"
            className="text-sm"
            onSave={saveIntent("week")}
          />
        </AsideSection>
        {syncLine}
      </>
    );
  } else {
    const filter: TaskBacklogFilter = search.filter ?? "all";
    const { open, recurring, done, completed } = allTasks(tasks, filter);
    const filters: ReadonlyArray<{ readonly value: TaskBacklogFilter; readonly label: string }> = [
      { value: "all", label: "All" },
      { value: "week", label: "Week backlog" },
      { value: "month", label: "Month backlog" },
      { value: "year", label: "Year backlog" },
      { value: "recurring", label: "Recurring" },
      { value: "completed", label: `Completed · ${completed}` },
    ];
    const addHome = defaultHomeForView("all", search, today);
    const proposedHere = proposedTasksForView(tasks, "all", today, filter);
    body = (
      <>
        <h1 className="font-semibold text-2xl">All tasks</h1>
        <div role="tablist" aria-label="Backlog filter" className="flex flex-wrap gap-1.5 pt-4">
          {filters.map((entry) => (
            <button
              key={entry.value}
              role="tab"
              type="button"
              aria-selected={filter === entry.value}
              className={cn(
                "h-7 cursor-pointer rounded-full border px-3 text-xs",
                filter === entry.value
                  ? "border-transparent bg-accent font-medium text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
              onClick={() =>
                void navigate({
                  to: "/tasks/$view",
                  params: { view: "all" },
                  search: tasksSearch(search, {
                    filter: entry.value === "all" ? undefined : entry.value,
                  }),
                })
              }
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="pt-3">
          {filter === "completed" ? (
            done.length === 0 ? (
              <p className="py-6 text-muted-foreground text-sm">Nothing completed yet.</p>
            ) : (
              list(done, "Completed", false)
            )
          ) : (
            <>
              {proposedHere.length > 0 ? (
                <div className="pb-3">
                  <ProposedTasks tasks={proposedHere} context={context} />
                </div>
              ) : null}
              {filter !== "recurring" ? (
                <AddTaskRow label="Add to backlog" onAdd={add(addHome)} />
              ) : null}
              {list(open, "Tasks", filter !== "all")}
              {recurring.length > 0 ? (
                <>
                  {filter === "all" ? <TasksSectionLabel>Recurring</TasksSectionLabel> : null}
                  {list(recurring, "Recurring")}
                </>
              ) : null}
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <TaskDragProvider
          tasks={allTaskRecords}
          onDropOnRange={onDropOnRange}
          onDropOnDay={onDropOnDay}
          onDropOnSidebar={(task) =>
            void moveTask(task, homeForMove({ kind: "today" }, task.home, today))
          }
          renderOverlay={(task) => <TaskDragPreview task={task} />}
        >
          <WorkspacePageHeader electron={isElectron} className="border-b border-border">
            <RangeTabs
              view={view}
              today={today}
              todayCount={counts.today}
              shortcutFor={shortcutFor}
              onSelect={(next) =>
                goTo(next, projectFilter === null ? {} : { project: projectFilter })
              }
            />
            <div className="ms-auto flex items-center gap-2">
              {environmentId !== null ? <TaskSyncChip indicator={sync} /> : null}
              <ProjectFilterMenu value={projectFilter} onChange={setFilter} />
              <button
                type="button"
                className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => openTaskQuickAdd()}
              >
                <PlusIcon aria-hidden className="size-4" />
                Add task
                {quickAddShortcut ? (
                  <span className="text-muted-foreground text-xs">{quickAddShortcut}</span>
                ) : null}
              </button>
            </div>
          </WorkspacePageHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex w-full max-w-5xl gap-12 px-6 pt-8 pb-16 sm:px-12">
              <main ref={mainRef} className="min-w-0 max-w-2xl flex-1">
                {environmentId !== null &&
                !taskEnvironmentStatus.connected &&
                taskEnvironmentStatus.phase !== null ? (
                  <p
                    role="status"
                    data-testid="tasks-reconnecting"
                    className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm"
                  >
                    {taskEnvironmentStatus.remoteLabel ?? "This Mac's server"} is reconnecting.
                    Showing the last synced Tasks; changes will fail until it is back.
                  </p>
                ) : null}
                {body}
                {selectedTasks.length > 0 ? (
                  <div
                    aria-label="Selected task actions"
                    className="sticky bottom-4 flex items-center gap-3 rounded-lg border border-border bg-card p-3 shadow-md"
                  >
                    <span>{selectedTasks.length} selected</span>
                    <TaskMoveMenu
                      home={selectedTasks[0]!.home}
                      today={today}
                      onMove={(target) => {
                        for (const task of selectedTasks)
                          void actions.move(task, homeForMove(target, task.home, today));
                      }}
                      onPickDate={(date) => {
                        for (const task of selectedTasks)
                          void actions.move(task, { kind: "date", date });
                      }}
                    >
                      Move
                    </TaskMoveMenu>
                    <button
                      type="button"
                      disabled={!findGlobalAssistantProject(projects)}
                      onClick={() => {
                        const assistant = findGlobalAssistantProject(projects);
                        if (assistant) void handToAgent(selectedTasks, "coordinator", assistant);
                      }}
                    >
                      Hand to Assistant
                    </button>
                    <button type="button" onClick={deleteSelection}>
                      Delete {selectedTasks.length}
                    </button>
                    <button type="button" onClick={selection.clear}>
                      Clear selection
                    </button>
                  </div>
                ) : null}
              </main>
              {aside !== null ? (
                <aside className="hidden w-52 shrink-0 flex-col gap-6 pt-1 lg:flex">{aside}</aside>
              ) : null}
            </div>
          </ScrollArea>
        </TaskDragProvider>
      </div>
    </SidebarInset>
  );
}
