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
  taskIntentFor,
  todayTasks,
  upcomingTasks,
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
import { Link, useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, ListFilterIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useProjects, useThreadShells } from "../../state/entities";
import { useTaskToday, useTasks } from "../../state/tasks";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { useHandToAgent } from "./handToAgent";
import {
  AddTaskRow,
  ProposedTasks,
  TaskList,
  TasksSectionLabel,
  useExpandedTask,
} from "./TaskList";
import type { TaskRowContext } from "./TaskRow";
import { TaskSyncCard } from "./TaskSyncCard";
import { useTaskActions } from "./useTaskActions";

export type TasksView = "today" | "week" | "month" | "year" | "upcoming" | "all";
export const TASK_VIEWS: ReadonlyArray<TasksView> = [
  "today",
  "week",
  "month",
  "year",
  "upcoming",
  "all",
];

const VIEW_LABEL: Record<TasksView, string> = {
  today: "Today",
  week: "Week",
  month: "Month",
  year: "Year",
  upcoming: "Upcoming",
  all: "All tasks",
};

export interface TasksSearch {
  readonly project?: string | undefined;
  readonly filter?: Exclude<TaskBacklogFilter, "all"> | undefined;
}

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
      maxLength={280}
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

function AsideLink(props: { readonly to: TasksView; readonly children: ReactNode }) {
  return (
    <Link
      to="/tasks/$view"
      params={{ view: props.to }}
      className="py-0.5 text-muted-foreground text-sm hover:text-foreground"
    >
      {props.children}
    </Link>
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
  const { expandedId, toggle } = useExpandedTask();
  const [showCompleted, setShowCompleted] = useState(false);
  const projectFilter = search.project ?? null;
  const tasks = useMemo(
    () => filterTasksByProject(allTaskRecords, projectFilter),
    [allTaskRecords, projectFilter],
  );
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
  const setFilter = (project: string | null) =>
    void navigate({
      to: "/tasks/$view",
      params: { view },
      search: tasksSearch(search, { project: project ?? undefined }),
    });

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
            <>
              <p className="py-6 text-muted-foreground text-sm">Nothing on today's plate.</p>
              <div className="mb-6 rounded-xl border border-border p-4 lg:hidden">
                <TaskSyncCard compact />
              </div>
            </>
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
        <AsideSection>
          <AsideLink to="upcoming">View upcoming tasks</AsideLink>
          <AsideLink to="all">View all tasks</AsideLink>
        </AsideSection>
        <TaskSyncCard compact />
      </>
    );
  } else if (view === "week" || view === "month" || view === "year") {
    const horizon: TaskHorizon = view;
    const period = taskPeriodFor(horizon, today);
    const committed = committedTasks(tasks, horizon, today);
    const backlog = backlogTasks(tasks, horizon);
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
          key={taskIntentFor(intents, horizon, today)?.text ?? ""}
          intent={taskIntentFor(intents, horizon, today)}
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
          <AsideLink to="all">View all tasks</AsideLink>
        </AsideSection>
      </>
    );
  } else if (view === "upcoming") {
    const groups = upcomingTasks(tasks, today);
    body = (
      <>
        <h1 className="font-semibold text-2xl">Upcoming</h1>
        <p className="pt-1 text-muted-foreground text-sm">Next 7 days</p>
        {groups.map((group) => (
          <section key={group.date} className="pt-6">
            <div className="flex items-baseline gap-2 border-border border-b pb-1.5">
              <h2 className="font-medium text-sm">{formatTaskDayTitle(group.date)}</h2>
              <span className="text-muted-foreground text-xs">
                {formatUpcomingOffset(group.date, today)}
              </span>
              <span className="ms-auto text-muted-foreground text-xs">
                {group.tasks.length === 0
                  ? ""
                  : `${group.tasks.length} ${group.tasks.length === 1 ? "task" : "tasks"}`}
              </span>
            </div>
            <div className="pt-1">
              {list(group.tasks, formatTaskDayTitle(group.date))}
              <AddTaskRow onAdd={add({ kind: "date", date: group.date })} />
            </div>
          </section>
        ))}
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
        <AsideSection>
          <AsideLink to="today">View today</AsideLink>
          <AsideLink to="all">View all tasks</AsideLink>
        </AsideSection>
      </>
    );
  } else {
    const filter = search.filter ?? "all";
    const { open, recurring, completed } = allTasks(tasks, filter);
    const filters: ReadonlyArray<{ readonly value: TaskBacklogFilter; readonly label: string }> = [
      { value: "all", label: "All" },
      { value: "week", label: "Week backlog" },
      { value: "month", label: "Month backlog" },
      { value: "year", label: "Year backlog" },
      { value: "recurring", label: "Recurring" },
    ];
    const addHome: TaskHome =
      filter === "week" || filter === "month" || filter === "year"
        ? { kind: "backlog", horizon: filter }
        : { kind: "backlog", horizon: null };
    body = (
      <>
        <h1 className="font-semibold text-2xl">Tasks</h1>
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
          {filter !== "recurring" ? <AddTaskRow onAdd={add(addHome)} /> : null}
          {list(open, "Tasks", filter !== "all")}
          {recurring.length > 0 ? (
            <>
              <TasksSectionLabel>Recurring</TasksSectionLabel>
              {list(recurring, "Recurring")}
            </>
          ) : null}
          {completed > 0 ? (
            <p className="pt-4 text-muted-foreground text-xs">Completed · {completed}</p>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            <Link
              to="/tasks/$view"
              params={{ view: "today" }}
              className="text-muted-foreground hover:text-foreground"
            >
              Tasks
            </Link>
            <span aria-hidden className="text-muted-foreground">
              /
            </span>
            <span className="font-medium">{VIEW_LABEL[view]}</span>
          </nav>
          <div className="ms-auto">
            <ProjectFilterMenu value={projectFilter} onChange={setFilter} />
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
