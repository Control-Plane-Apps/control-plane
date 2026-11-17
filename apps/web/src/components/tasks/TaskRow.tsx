import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  formatTaskHome,
  formatTaskRecurrence,
  formatTaskTime,
  handoffLabel,
  homeForMove,
  isTaskOverdue,
  type TaskAgentState,
} from "@t3tools/client-runtime/state/projects";
import {
  findGlobalAssistantProject,
  isProposedTask,
  type Task,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BellIcon,
  CalendarIcon,
  CheckIcon,
  CircleCheckIcon,
  GripVerticalIcon,
  LinkIcon,
  MoreHorizontalIcon,
  RepeatIcon,
  XIcon,
} from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useIsMobile } from "../../hooks/useMediaQuery";

import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProjectFavicon } from "../ProjectFavicon";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { TASK_DRAG_TRANSITION, usePrefersReducedMotion } from "./taskDrag";
import { TaskMoveMenu, TaskReminderMenu, TaskRepeatMenu } from "./TaskMenus";
import type { TaskActions } from "./useTaskActions";

export interface TaskRowContext {
  readonly today: string;
  readonly actions: TaskActions;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly onHandToAssistant: (task: Task) => void;
}

function chipClass(active = false) {
  return cn(
    "inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs outline-none",
    "text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
    active && "bg-accent text-foreground",
  );
}

/**
 * Check-off, matching Lucive desktop (lucive/src/components/planning):
 * - PlanTaskRow.tsx:276-292 handleCheckbox: the box fills and the title
 *   strikes through at once, then after 350ms the completion is written and
 *   the row leaves the list. Clicks during those 350ms are ignored (no
 *   cancel). Reopening a completed task writes immediately.
 * - planning.css:404 checkbox `transition: all 0.2s ease`; :413-415
 *   `--completing` scales it to 1.1 for the beat.
 * - planning.css:429 title `transition: all 0.3s ease`; :432-435 done is
 *   secondary color + line-through; :437-439 `--fading` is opacity 0.5.
 * - No exit animation: Lucive removes the row outright (no fade-out or height
 *   collapse; PlanTaskList.tsx re-renders without it).
 * Reduced motion drops the transitions; the 350ms timing stays.
 */
export const CHECK_OFF_DELAY_MS = 350;

/** The square checkbox; dashed while the task is still a proposal. */
export function TaskCheckbox(props: {
  readonly checked: boolean;
  readonly proposed?: boolean;
  readonly label: string;
  readonly onToggle: () => void;
  readonly disabled?: boolean;
  /** The 350ms beat between checking off and the write: scaled up 1.1. */
  readonly completing?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      className={cn(
        "inline-flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] border-[1.5px] outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
        "transition-all duration-200 ease-[ease] motion-reduce:transition-none",
        props.completing && "scale-110",
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
      {props.checked ? <CheckIcon aria-hidden className="size-3" strokeWidth={3.2} /> : null}
    </button>
  );
}

function rowMeta(task: Task, today: string, inGroup: boolean): string | null {
  if (task.recurrence !== undefined) return formatTaskRecurrence(task.recurrence);
  // A day card or a commitment list already says when its rows are: show the time only.
  if (inGroup) {
    return task.home.kind === "date" && task.home.reminderTime !== undefined
      ? formatTaskTime(task.home.reminderTime)
      : null;
  }
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
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
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
        <CircleCheckIcon aria-hidden className="size-3.5 shrink-0 text-success-foreground" />
        <span className="min-w-0 truncate text-success-foreground">
          {state.status.title} is done
        </span>
        <button
          type="button"
          className="shrink-0 cursor-pointer font-medium text-success-foreground hover:underline"
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
  readonly selected?: boolean;
  readonly onSelectClick?: (event: MouseEvent) => void;
  readonly onHover?: (hovered: boolean) => void;
  readonly moveRequest?: number;
  readonly context: TaskRowContext;
  /** Open tasks drag (to reorder, or onto a range tab or the sidebar). */
  readonly draggable?: boolean;
  /** Whether the list it sits in takes reorders. */
  readonly reorderable?: boolean;
  readonly hidePeriod?: boolean;
}) {
  const { task, state, context, expanded, onToggleExpanded } = props;
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const rowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!expanded || mobile) return;
    const outside = (event: globalThis.MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || rowRef.current?.contains(target)) return;
      // Base UI menus and date pickers render in portals outside the row.
      if (target.closest('[role="menu"], [role="dialog"], [data-base-ui-portal]')) return;
      onToggleExpanded();
    };
    document.addEventListener("click", outside, true);
    return () => document.removeEventListener("click", outside, true);
  }, [expanded, mobile, onToggleExpanded]);
  const project = context.projects.find((p) => p.id === task.links?.projectId) ?? null;
  const status =
    task.links?.statusId === undefined
      ? undefined
      : project?.assistant?.statuses?.find((s) => s.id === task.links!.statusId);
  const reducedMotion = usePrefersReducedMotion();
  const dragEnabled = props.draggable === true && !expanded;
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    disabled: !dragEnabled,
    data: {
      reorderable: props.reorderable === true,
      homeDate: task.home.kind === "date" ? task.home.date : null,
    },
    transition: reducedMotion ? null : TASK_DRAG_TRANSITION,
  });
  // Lucive's check-off beat (see CHECK_OFF_DELAY_MS): the write fires after
  // the delay even if the row unmounts, and clicks during it are ignored.
  const [completing, setCompleting] = useState(false);
  const completed = task.status === "completed" || completing;
  const toggleCompleted = () => {
    if (completing) return;
    if (task.status === "completed") {
      void context.actions.setCompleted(task, false);
      return;
    }
    setCompleting(true);
    setTimeout(() => {
      void context.actions.setCompleted(task, true);
      setCompleting(false);
    }, CHECK_OFF_DELAY_MS);
  };
  const overdue = isTaskOverdue(task, context.today);
  const meta = rowMeta(task, context.today, props.hidePeriod === true);
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
      ref={(node) => {
        rowRef.current = node;
        setNodeRef(node);
      }}
      data-task-expanded={expanded || undefined}
      data-selected={(!expanded && props.selected) || undefined}
      onMouseEnter={() => props.onHover?.(true)}
      onMouseLeave={() => props.onHover?.(false)}
      onClick={(event) => {
        if (
          mobile ||
          expanded ||
          (event.target instanceof Element &&
            event.target.closest("button, input, textarea, select, a"))
        )
          return;
        props.onSelectClick?.(event);
      }}
      onDoubleClick={(event) => {
        if (
          mobile ||
          expanded ||
          (event.target instanceof Element &&
            event.target.closest("input, textarea, select, a, button:not([data-task-title])"))
        )
          return;
        props.onToggleExpanded();
      }}
      className="group/task relative list-none"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // Lucive PlanTaskRow.tsx:315-316: the lifted row at half opacity, on top.
        opacity: isDragging ? 0.5 : undefined,
        zIndex: isDragging ? 10 : undefined,
      }}
      data-task-id={task.id}
    >
      <div
        className={cn(
          "relative flex flex-col rounded-lg transition-colors duration-150",
          expanded
            ? "-mx-6 my-1.5 border border-border bg-card px-6 py-2.5 shadow-sm"
            : "-mx-2 my-0.5 px-2 py-2 hover:bg-accent/30 group-data-[selected=true]/task:bg-accent/30 group-data-[highlighted=true]/task:bg-accent/30",
        )}
      >
        <div className={cn("flex min-w-0 items-center gap-2.5", !expanded && "pr-7")}>
          {props.draggable ? (
            <button
              type="button"
              ref={setActivatorNodeRef}
              {...attributes}
              {...(dragEnabled ? listeners : {})}
              aria-label={`Reorder ${task.title}`}
              disabled={!dragEnabled}
              className={cn(
                "absolute inline-flex size-4.5 cursor-grab items-center justify-center rounded text-muted-foreground/60 opacity-0 outline-none",
                "group-hover/task:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                expanded ? "left-1" : "-left-4",
                (expanded || isDragging) && "opacity-100",
              )}
              onClick={(event) => event.stopPropagation()}
            >
              <GripVerticalIcon aria-hidden className="size-3.5" />
            </button>
          ) : null}
          {!expanded ? (
            <TaskMoveMenu
              home={task.home}
              today={context.today}
              openRequest={props.moveRequest ?? 0}
              className="absolute right-1 top-1 inline-flex size-7 items-center justify-center rounded-md bg-card text-muted-foreground opacity-0 outline-none group-hover/task:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:opacity-100"
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
            </TaskMoveMenu>
          ) : null}
          <TaskCheckbox
            checked={completed}
            completing={completing}
            label={completed ? `Reopen ${task.title}` : `Complete ${task.title}`}
            onToggle={toggleCompleted}
          />
          {expanded ? (
            <TitleInput key={task.title} task={task} context={context} />
          ) : (
            <button
              type="button"
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-start outline-none"
              data-task-title
              aria-expanded={expanded}
              onClick={(event) => {
                event.stopPropagation();
                if (mobile || props.onSelectClick === undefined) props.onToggleExpanded();
                else props.onSelectClick(event);
              }}
            >
              {/* Long titles wrap rather than truncate. */}
              <span
                className={cn(
                  "min-w-0 break-words font-semibold text-[15px] leading-snug",
                  "transition-all duration-300 ease-[ease] motion-reduce:transition-none",
                  completed && "font-normal text-muted-foreground line-through",
                  completing && "opacity-50",
                )}
              >
                {task.title}
              </span>
              {agentActive ? (
                <span
                  role="img"
                  aria-label={
                    state.kind === "agent-working"
                      ? "An agent is working on this"
                      : "Handed to an agent"
                  }
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    state.kind === "agent-working" ? "bg-info" : "bg-info/50",
                  )}
                />
              ) : null}
            </button>
          )}
          {expanded ? (
            <TaskRowMenu task={task} context={context} onClose={props.onToggleExpanded} />
          ) : (
            <span className="flex shrink-0 items-center gap-2 text-xs">
              {status !== undefined && state.kind !== "workstream-done" ? (
                <span className="inline-flex max-w-40 items-center gap-1 text-muted-foreground">
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
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
          <ExpandedTask
            task={task}
            state={state}
            context={context}
            project={project}
            moveRequest={props.moveRequest ?? 0}
          />
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
    </li>
  );
}

function TitleInput(props: { readonly task: Task; readonly context: TaskRowContext }) {
  // Keyed on the stored title by the caller, so a remote rename resets it.
  const [value, setValue] = useState(props.task.title);
  const cancelled = useRef(false);
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
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
      maxLength={120}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelled.current = true;
          setValue(props.task.title);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function NotesInput(props: { readonly task: Task; readonly context: TaskRowContext }) {
  // Keyed on the stored notes by the caller, so a remote edit resets it.
  const [value, setValue] = useState(props.task.notes ?? "");
  return (
    <textarea
      aria-label="Notes"
      placeholder="Notes"
      rows={1}
      className="w-full resize-none bg-transparent text-[13px] text-muted-foreground leading-relaxed outline-none [field-sizing:content] placeholder:text-muted-foreground/60"
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
  readonly moveRequest?: number;
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
      <NotesInput key={task.notes ?? ""} task={task} context={context} />
      <div className="flex flex-wrap items-center gap-1">
        <TaskMoveMenu
          openRequest={props.moveRequest ?? 0}
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
                <span aria-hidden className="size-1.5 rounded-full bg-success" />
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
        {!isProposedTask(task) ? <HandToAssistantChip task={task} context={context} /> : null}
      </div>
    </div>
  );
}

/**
 * One plain chip, like Tomorrow and Remind: it sends the task straight to the
 * Assistant. Once it is there the chip says so; a task another thread has
 * shows who has it beside the chip.
 */
function HandToAssistantChip(props: { readonly task: Task; readonly context: TaskRowContext }) {
  const { task, context } = props;
  const assistant = findGlobalAssistantProject(context.projects);
  if (assistant === undefined) return null;
  const assistantThreadId = assistant.assistant?.coordinatorThreadId;
  const handedTo = task.handoff;
  if (handedTo !== undefined && handedTo.threadId === assistantThreadId) {
    return <span className={cn(chipClass(true), "cursor-default")}>Handed to Assistant</span>;
  }
  const owner =
    handedTo === undefined
      ? null
      : context.projects.find((p) => p.assistant?.coordinatorThreadId === handedTo.threadId);
  return (
    <>
      <button type="button" className={chipClass()} onClick={() => context.onHandToAssistant(task)}>
        Hand to Assistant
      </button>
      {handedTo !== undefined ? (
        <span className="text-muted-foreground text-xs">
          {handoffLabel(handedTo, assistantThreadId, owner?.title)}
        </span>
      ) : null}
    </>
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
          {task.recurrence !== undefined && task.home.kind === "date" ? (
            <>
              <MenuItem
                variant="destructive"
                onClick={() => void context.actions.delete(task, "occurrence")}
              >
                Delete this occurrence
              </MenuItem>
              <MenuItem
                variant="destructive"
                onClick={() => void context.actions.delete(task, "series")}
              >
                Stop repeating and delete
              </MenuItem>
            </>
          ) : (
            <MenuItem variant="destructive" onClick={() => void context.actions.delete(task)}>
              Delete task
            </MenuItem>
          )}
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
