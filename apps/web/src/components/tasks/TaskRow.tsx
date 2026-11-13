import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  formatTaskHome,
  formatTaskRecurrence,
  formatTaskTime,
  homeForMove,
  isTaskOverdue,
  type TaskAgentState,
} from "@t3tools/client-runtime/state/projects";
import { isProposedTask, type Task, type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BellIcon,
  BotIcon,
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  GripVerticalIcon,
  LinkIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  RepeatIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProjectFavicon } from "../ProjectFavicon";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { TaskMoveMenu, TaskReminderMenu, TaskRepeatMenu } from "./TaskMenus";
import type { TaskActions } from "./useTaskActions";

export const TASK_DRAG_TYPE = "application/x-cplane-task";

export interface TaskRowContext {
  readonly today: string;
  readonly actions: TaskActions;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly onHandToAgent: (
    task: Task,
    kind: "coordinator" | "agent",
    project: EnvironmentProject,
  ) => void;
}

function chipClass(active = false) {
  return cn(
    "inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs outline-none",
    "text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
    active && "bg-accent text-foreground",
  );
}

/** The square checkbox; dashed while the task is still a proposal. */
export function TaskCheckbox(props: {
  readonly checked: boolean;
  readonly proposed?: boolean;
  readonly label: string;
  readonly onToggle: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      className={cn(
        "inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
        props.proposed
          ? "border-dashed border-muted-foreground/60"
          : props.checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/45 hover:border-foreground/70",
      )}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle();
      }}
    >
      {props.checked ? <CheckIcon aria-hidden className="size-3" strokeWidth={3} /> : null}
    </button>
  );
}

function rowMeta(task: Task, today: string): string | null {
  if (task.recurrence !== undefined) return formatTaskRecurrence(task.recurrence);
  if (task.home.kind === "date" && task.home.date === today) {
    return task.home.reminderTime !== undefined ? formatTaskTime(task.home.reminderTime) : null;
  }
  return formatTaskHome(task.home, today);
}

/** "Needs you", "Workstream done", agent working: the line under a handed-off task. */
function LifecycleLine(props: {
  readonly task: Task;
  readonly state: TaskAgentState;
  readonly context: TaskRowContext;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { state, task, context } = props;
  if (state.kind === "needs-you") {
    const project = context.projects.find((p) => p.id === task.links?.projectId);
    const coordinator = project?.assistant?.coordinatorThreadId;
    return (
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-500" />
        <span className="shrink-0 text-warning-foreground">Needs you</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {state.status.decision?.question ?? state.status.summary}
        </span>
        {coordinator != null ? (
          <button
            type="button"
            className="shrink-0 cursor-pointer font-medium text-warning-foreground hover:underline"
            onClick={() => props.onOpenThread(coordinator)}
          >
            Answer
          </button>
        ) : null}
        {task.handoff !== undefined ? (
          <button
            type="button"
            className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
            onClick={() => props.onOpenThread(task.handoff!.threadId)}
          >
            Open thread
          </button>
        ) : null}
      </div>
    );
  }
  if (state.kind === "workstream-done") {
    return (
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <CircleCheckIcon aria-hidden className="size-3.5 shrink-0 text-emerald-600" />
        <span className="min-w-0 truncate text-emerald-700 dark:text-emerald-400">
          {state.status.title} is done
        </span>
        <button
          type="button"
          className="shrink-0 cursor-pointer font-medium text-emerald-700 hover:underline dark:text-emerald-400"
          onClick={() => void context.actions.setCompleted(task, true)}
        >
          Complete task
        </button>
        <button
          type="button"
          className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
          onClick={() =>
            void context.actions.patch(task, {
              completionPromptDismissedAt: new Date().toISOString(),
            })
          }
        >
          Not yet
        </button>
      </div>
    );
  }
  return null;
}

export function TaskRow(props: {
  readonly task: Task;
  readonly state: TaskAgentState;
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
  readonly context: TaskRowContext;
  readonly draggable?: boolean;
  readonly onDragStart?: (event: DragEvent<HTMLLIElement>) => void;
  readonly onDragOver?: (event: DragEvent<HTMLLIElement>) => void;
  readonly onDrop?: (event: DragEvent<HTMLLIElement>) => void;
  readonly dropIndicator?: "before" | "after" | null;
  readonly dimmed?: boolean;
}) {
  const { task, state, context, expanded } = props;
  const navigate = useNavigate();
  const project = context.projects.find((p) => p.id === task.links?.projectId) ?? null;
  const status =
    task.links?.statusId === undefined
      ? undefined
      : project?.assistant?.statuses?.find((s) => s.id === task.links!.statusId);
  const completed = task.status === "completed";
  const overdue = isTaskOverdue(task, context.today);
  const meta = rowMeta(task, context.today);
  const agentActive = state.kind === "agent-working" || state.kind === "handed-off";

  const openThread = (threadId: ThreadId) => {
    const target = context.projects.find((p) => p.id === task.links?.projectId);
    if (target === undefined) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(target.environmentId, threadId)),
    });
  };

  return (
    <li
      className={cn("group/task relative list-none", props.dimmed && "opacity-40")}
      draggable={props.draggable === true && !expanded}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      data-task-id={task.id}
    >
      {props.dropIndicator === "before" ? (
        <span aria-hidden className="absolute inset-x-6 -top-px h-0.5 rounded-full bg-primary" />
      ) : null}
      <div
        className={cn(
          "relative -mx-6 flex flex-col rounded-lg px-6",
          expanded
            ? "my-1.5 border border-border bg-card py-2.5 shadow-sm"
            : "py-1.5 hover:bg-accent/30",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          {props.draggable ? (
            <GripVerticalIcon
              aria-hidden
              className="absolute left-1.5 size-3.5 cursor-grab text-muted-foreground/60 opacity-0 group-hover/task:opacity-100"
            />
          ) : null}
          <TaskCheckbox
            checked={completed}
            label={completed ? `Reopen ${task.title}` : `Complete ${task.title}`}
            onToggle={() => void context.actions.setCompleted(task, !completed)}
          />
          {expanded ? (
            <TitleInput task={task} context={context} />
          ) : (
            <button
              type="button"
              className={cn(
                "min-w-0 flex-1 cursor-pointer truncate text-start font-semibold text-[15px] outline-none",
                completed && "font-normal text-muted-foreground line-through",
              )}
              onClick={props.onToggleExpanded}
            >
              {task.title}
            </button>
          )}
          {expanded ? (
            <TaskRowMenu task={task} context={context} onClose={props.onToggleExpanded} />
          ) : (
            <span className="flex shrink-0 items-center gap-2 text-xs">
              {agentActive ? (
                <span
                  role="img"
                  aria-label={
                    state.kind === "agent-working"
                      ? "An agent is working on this"
                      : "Handed to an agent"
                  }
                  className={cn(
                    "size-1.5 rounded-full",
                    state.kind === "agent-working" ? "bg-sky-500" : "bg-sky-500/50",
                  )}
                />
              ) : null}
              {status !== undefined && state.kind !== "workstream-done" ? (
                <span className="inline-flex max-w-40 items-center gap-1 text-muted-foreground">
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emerald-600" />
                  <span className="truncate">{status.title}</span>
                </span>
              ) : null}
              {meta !== null ? (
                <span className={cn(overdue ? "text-warning-foreground" : "text-muted-foreground")}>
                  {meta}
                </span>
              ) : null}
            </span>
          )}
        </div>
        {expanded ? (
          <ExpandedTask task={task} state={state} context={context} project={project} />
        ) : null}
        {!expanded && (state.kind === "needs-you" || state.kind === "workstream-done") ? (
          <div className="ps-6.5 pt-1">
            <LifecycleLine task={task} state={state} context={context} onOpenThread={openThread} />
          </div>
        ) : null}
        {expanded && (state.kind === "needs-you" || state.kind === "workstream-done") ? (
          <div className="ps-6.5 pt-2">
            <LifecycleLine task={task} state={state} context={context} onOpenThread={openThread} />
          </div>
        ) : null}
      </div>
      {props.dropIndicator === "after" ? (
        <span aria-hidden className="absolute inset-x-6 -bottom-px h-0.5 rounded-full bg-primary" />
      ) : null}
    </li>
  );
}

function TitleInput(props: { readonly task: Task; readonly context: TaskRowContext }) {
  const [value, setValue] = useState(props.task.title);
  useEffect(() => setValue(props.task.title), [props.task.title]);
  const commit = () => {
    const title = value.trim();
    if (title.length === 0 || title === props.task.title) {
      setValue(props.task.title);
      return;
    }
    void props.context.actions.patch(props.task, { title });
  };
  return (
    <input
      aria-label="Task title"
      className="min-w-0 flex-1 bg-transparent font-semibold text-[15px] outline-none"
      value={value}
      maxLength={200}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setValue(props.task.title);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function NotesInput(props: { readonly task: Task; readonly context: TaskRowContext }) {
  const [value, setValue] = useState(props.task.notes ?? "");
  useEffect(() => setValue(props.task.notes ?? ""), [props.task.notes]);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    element.style.height = "0px";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      aria-label="Notes"
      placeholder="Notes"
      rows={1}
      className="w-full resize-none bg-transparent text-[13px] text-muted-foreground leading-relaxed outline-none placeholder:text-muted-foreground/60"
      value={value}
      maxLength={4000}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        if (value.trim() !== (props.task.notes ?? "")) {
          void props.context.actions.patch(props.task, { notes: value });
        }
      }}
    />
  );
}

function ExpandedTask(props: {
  readonly task: Task;
  readonly state: TaskAgentState;
  readonly context: TaskRowContext;
  readonly project: EnvironmentProject | null;
}) {
  const { task, context, project } = props;
  const reminder = task.home.kind === "date" ? task.home.reminderTime : undefined;
  const status =
    task.links?.statusId === undefined
      ? undefined
      : project?.assistant?.statuses?.find((s) => s.id === task.links!.statusId);
  const assistantProjects = context.projects.filter((p) => p.assistant != null);
  const statuses = project?.assistant?.statuses ?? [];
  return (
    <div className="flex flex-col gap-2 ps-6.5 pt-1.5">
      <NotesInput task={task} context={context} />
      <div className="flex flex-wrap items-center gap-1">
        <TaskMoveMenu
          home={task.home}
          today={context.today}
          className={chipClass()}
          onMove={(target) =>
            void context.actions.move(task, homeForMove(target, task.home, context.today))
          }
          onPickDate={(date) =>
            void context.actions.move(
              task,
              homeForMove({ kind: "date", date }, task.home, context.today),
            )
          }
        >
          <CalendarIcon aria-hidden className="size-3.5" />
          {formatTaskHome(task.home, context.today)}
        </TaskMoveMenu>
        {task.home.kind === "date" ? (
          <TaskReminderMenu
            time={reminder}
            className={chipClass(reminder !== undefined)}
            formatTime={formatTaskTime}
            onChange={(time) => {
              if (task.home.kind !== "date") return;
              const { reminderTime: _drop, ...rest } = task.home;
              void context.actions.move(
                task,
                time === null ? rest : { ...rest, reminderTime: time },
              );
            }}
          >
            <BellIcon aria-hidden className="size-3.5" />
            {reminder !== undefined ? formatTaskTime(reminder) : "Remind"}
          </TaskReminderMenu>
        ) : null}
        <Menu>
          <MenuTrigger className={chipClass(project !== null)} aria-label="Project">
            {project !== null ? <ProjectFavicon project={project} className="size-3.5" /> : null}
            {project?.title ?? "Project"}
          </MenuTrigger>
          <MenuPopup align="start" className="w-52">
            {assistantProjects.map((candidate) => (
              <MenuItem
                key={`${candidate.environmentId}:${candidate.id}`}
                onClick={() =>
                  void context.actions.patch(task, { links: { projectId: candidate.id } })
                }
              >
                {candidate.title}
              </MenuItem>
            ))}
            {project !== null ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => void context.actions.patch(task, { links: null })}>
                  No project
                </MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
        {project !== null && statuses.length > 0 ? (
          <Menu>
            <MenuTrigger
              className={chipClass(status !== undefined)}
              aria-label="Link to a workstream"
            >
              {status !== undefined ? (
                <span aria-hidden className="size-1.5 rounded-full bg-emerald-600" />
              ) : (
                <LinkIcon aria-hidden className="size-3.5" />
              )}
              {status?.title ?? "Link"}
            </MenuTrigger>
            <MenuPopup align="start" className="w-56">
              {statuses
                .filter((s) => s.dismissedAt === undefined)
                .map((candidate) => (
                  <MenuItem
                    key={candidate.id}
                    onClick={() =>
                      void context.actions.patch(task, {
                        links: { ...task.links, projectId: project.id, statusId: candidate.id },
                      })
                    }
                  >
                    {candidate.title}
                  </MenuItem>
                ))}
              {status !== undefined ? (
                <>
                  <MenuSeparator />
                  <MenuItem
                    onClick={() => {
                      const { statusId: _drop, ...rest } = task.links ?? {};
                      void context.actions.patch(task, { links: rest });
                    }}
                  >
                    Unlink workstream
                  </MenuItem>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}
        <TaskRepeatMenu
          recurrence={task.recurrence}
          disabled={task.home.kind !== "date"}
          className={chipClass(task.recurrence !== undefined)}
          onChange={(recurrence) => void context.actions.patch(task, { recurrence })}
        >
          <RepeatIcon aria-hidden className="size-3.5" />
          {task.recurrence !== undefined ? formatTaskRecurrence(task.recurrence) : "Repeat"}
        </TaskRepeatMenu>
      </div>
      {project !== null && project.assistant != null && !isProposedTask(task) ? (
        <HandToAgentMenu task={task} project={project} context={context} />
      ) : null}
    </div>
  );
}

function HandToAgentMenu(props: {
  readonly task: Task;
  readonly project: EnvironmentProject;
  readonly context: TaskRowContext;
}) {
  const { task, project, context } = props;
  const handedTo = task.handoff;
  return (
    <div className="flex items-center gap-2">
      <Menu>
        <MenuTrigger
          className={cn(
            chipClass(),
            "h-7 border border-border bg-background px-2 text-foreground hover:bg-accent",
          )}
        >
          <BotIcon aria-hidden className="size-3.5" />
          Hand to agent
          <ChevronDownIcon aria-hidden className="size-3 opacity-60" />
        </MenuTrigger>
        <MenuPopup align="start" className="w-60">
          <MenuItem onClick={() => context.onHandToAgent(task, "coordinator", project)}>
            <MessageCircleIcon aria-hidden className="size-3.5" />
            Ask {project.title} coordinator
          </MenuItem>
          <MenuItem onClick={() => context.onHandToAgent(task, "agent", project)}>
            <BotIcon aria-hidden className="size-3.5" />
            Start an agent in {project.title}
          </MenuItem>
        </MenuPopup>
      </Menu>
      {handedTo !== undefined ? (
        <span className="text-muted-foreground text-xs">
          {handedTo.kind === "coordinator" ? `With ${project.title} coordinator` : "With an agent"}
        </span>
      ) : null}
    </div>
  );
}

function TaskRowMenu(props: {
  readonly task: Task;
  readonly context: TaskRowContext;
  readonly onClose: () => void;
}): ReactNode {
  const { task, context } = props;
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <Menu>
        <MenuTrigger
          aria-label={`Task menu for ${task.title}`}
          className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <MoreHorizontalIcon aria-hidden className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end" className="w-44">
          {task.handoff !== undefined ? (
            <MenuItem onClick={() => void context.actions.handOff(task, null)}>
              Unlink agent thread
            </MenuItem>
          ) : null}
          <MenuItem
            onClick={() =>
              void context.actions.patch(
                task,
                { status: "cancelled" },
                `Could not cancel ${task.title}`,
              )
            }
          >
            Cancel task
          </MenuItem>
          <MenuItem variant="destructive" onClick={() => void context.actions.delete(task)}>
            Delete task
          </MenuItem>
        </MenuPopup>
      </Menu>
      <button
        type="button"
        aria-label="Close"
        className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={props.onClose}
      >
        <XIcon aria-hidden className="size-4" />
      </button>
    </span>
  );
}
