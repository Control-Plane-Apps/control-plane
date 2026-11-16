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
  proposedTasks,
  taskCounts,
  taskIntentFor,
  todayTasks,
  upcomingTasks,
  homeForMove,
  type TaskBacklogFilter,
  type TaskLifecycleThread,
} from "@t3tools/client-runtime/state/projects";
import {
  taskPeriodFor,
  type Task,
  type TaskHome,
  type TaskHorizon,
  type TaskIntent,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, ListFilterIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
} from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { cn } from "../../lib/utils";
import { useProjects, useThreadShells } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useTaskToday, useTasks } from "../../state/tasks";
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
  TaskList,
  TasksSectionLabel,
  useExpandedTask,
} from "./TaskList";
import { TASK_DRAG_TYPE, type TaskRowContext } from "./TaskRow";
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
 * tab moves its home; ⌘1 to ⌘6 switch while the view is open.
 */
function RangeTabs(props: {
  readonly view: TasksView;
  readonly today: string;
  /** Open today, the only count the switcher shows. */
  readonly todayCount: number;
  readonly shortcutFor: (index: number) => string | null;
  readonly onSelect: (view: TasksView) => void;
  readonly onDropTask: (event: DragEvent, view: TasksView) => void;
}) {
  const [dropView, setDropView] = useState<TasksView | null>(null);
  return (
    <div
      role="tablist"
      aria-label="Task ranges"
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/70 p-0.5"
    >
      {TASK_VIEWS.map((entry, index) => {
        const selected = entry === props.view;
        const count = entry === "today" ? props.todayCount : 0;
        const droppable = dropTargetForView(entry) !== null;
        const dropping = dropView === entry;
        const shortcut = props.shortcutFor(index);
        const tooltip = dropping
          ? dropLabelForView(entry, props.today)
          : shortcut !== null
            ? `${VIEW_LABEL[entry]} ${shortcut}`
            : null;
        const tab = (
          <button
            type="button"
            role="tab"
            aria-selected={selected}
            className={cn(
              "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-transparent px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "bg-background font-medium text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
              dropping && "border-primary border-dashed",
            )}
            onClick={() => props.onSelect(entry)}
            onDragOver={
              droppable
                ? (event) => {
                    if (!event.dataTransfer.types.includes(TASK_DRAG_TYPE)) return;
                    event.preventDefault();
                    if (dropView !== entry) setDropView(entry);
                  }
                : undefined
            }
            onDragLeave={() => setDropView((current) => (current === entry ? null : current))}
            onDrop={
              droppable
                ? (event) => {
                    setDropView(null);
                    props.onDropTask(event, entry);
                  }
                : undefined
            }
          >
            {VIEW_LABEL[entry]}
            {count > 0 ? (
              <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
            ) : null}
          </button>
        );
        return (
          <span key={entry} className="contents">
            {entry === "upcoming" ? (
              <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
            ) : null}
            {tooltip !== null ? (
              <Tooltip open={dropping ? true : undefined}>
                <TooltipTrigger render={tab} />
                <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
              </Tooltip>
            ) : (
              tab
            )}
          </span>
        );
      })}
    </div>
  );
}

export function TasksPage(props: { readonly view: TasksView; readonly search: TasksSearch }) {
  const { view, search } = props;
  const navigate = useNavigate();
  const today = useTaskToday();
  const { environmentId, tasks: allTaskRecords, intents } = useTasks();
  const projects = useProjects();
  const threads = useThreadShells() as ReadonlyArray<TaskLifecycleThread>;
  const actions = useTaskActions(environmentId);
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

  // ⌘1 to ⌘6 switch ranges while Tasks is open, using the thread-jump keys so
  // a remapped binding still works; everywhere else they still jump threads.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      const index = threadJumpIndexFromCommand(command ?? "");
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

  const shortcutFor = (index: number) => {
    const command = threadJumpCommandForIndex(index);
    return command === null ? null : shortcutLabelForCommand(keybindings, command);
  };

  const onDropTask = (event: DragEvent, target: TasksView) => {
    const move = dropTargetForView(target);
    const taskId = event.dataTransfer.getData(TASK_DRAG_TYPE);
    const task = allTaskRecords.find((candidate) => candidate.id === taskId);
    if (move === null || task === undefined) return;
    event.preventDefault();
    void actions.move(task, homeForMove(move, task.home, today));
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
        Tasks need this Mac's Control Plane server. Update it to the latest version to use Tasks.
      </p>
    );
  } else if (view === "today") {
    const open = todayTasks(tasks, today);
    const done = completedToday(tasks, today);
    const proposals = proposedTasks(tasks);
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
          {groups.map((group) => (
            <section
              key={group.date}
              aria-label={formatTaskDayTitle(group.date)}
              className="overflow-hidden rounded-xl border border-border bg-card px-4 pt-3 pb-1"
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
              {list(group.tasks, formatTaskDayTitle(group.date), true, true)}
              <AddTaskRow onAdd={add({ kind: "date", date: group.date })} />
            </section>
          ))}
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
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <RangeTabs
            view={view}
            today={today}
            todayCount={counts.today}
            shortcutFor={shortcutFor}
            onSelect={(next) =>
              goTo(next, projectFilter === null ? {} : { project: projectFilter })
            }
            onDropTask={onDropTask}
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
            <main className="min-w-0 max-w-2xl flex-1">{body}</main>
            {aside !== null ? (
              <aside className="hidden w-52 shrink-0 flex-col gap-6 pt-1 lg:flex">{aside}</aside>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
