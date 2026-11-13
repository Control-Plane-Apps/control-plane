import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";
import {
  formatTaskHome,
  taskAgentState,
  type TaskLifecycleProject,
  type TaskLifecycleThread,
} from "@t3tools/client-runtime/state/projects";
import type { Task } from "@t3tools/contracts";
import { ListTodoIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState, type DragEvent, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { TASK_DRAG_TYPE, TaskCheckbox, TaskRow, type TaskRowContext } from "./TaskRow";

/** Lists hold one expanded row at a time across the page. */
export function useExpandedTask() {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return {
    expandedId,
    toggle: (id: string) => setExpandedId((current) => (current === id ? null : id)),
  };
}

export function TaskList(props: {
  readonly tasks: ReadonlyArray<Task>;
  readonly context: TaskRowContext;
  readonly threads: ReadonlyArray<TaskLifecycleThread>;
  readonly expandedId: string | null;
  readonly onToggle: (id: string) => void;
  /** Reordering writes order keys; off for lists not in the user's own order. */
  readonly reorderable?: boolean;
  readonly label?: string;
  readonly hidePeriod?: boolean;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{
    readonly id: string;
    readonly side: "before" | "after";
  } | null>(null);
  useEffect(() => {
    if (dragId === null) return;
    const reset = () => {
      setDragId(null);
      setDrop(null);
    };
    window.addEventListener("dragend", reset);
    return () => window.removeEventListener("dragend", reset);
  }, [dragId]);
  const lifecycleProjects = props.context.projects as ReadonlyArray<TaskLifecycleProject>;

  const onDrop = (target: Task, side: "before" | "after") => {
    const movedId = dragId;
    setDragId(null);
    setDrop(null);
    if (movedId === null || movedId === target.id) return;
    const ids = props.tasks.map((task) => task.id as string).filter((id) => id !== movedId);
    const at = ids.indexOf(target.id) + (side === "after" ? 1 : 0);
    ids.splice(at, 0, movedId);
    const assignments = planPinnedReorder({
      orderedIds: ids,
      movedId,
      keysById: new Map(props.tasks.map((task) => [task.id as string, task.orderKey ?? null])),
    });
    for (const assignment of assignments) {
      const task = props.tasks.find((candidate) => candidate.id === assignment.id);
      if (task !== undefined)
        void props.context.actions.patch(task, { orderKey: assignment.orderKey as never });
    }
  };

  return (
    <ul aria-label={props.label} className="flex flex-col">
      {props.tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          state={taskAgentState(task, props.threads, lifecycleProjects)}
          expanded={props.expandedId === task.id}
          onToggleExpanded={() => props.onToggle(task.id)}
          context={props.context}
          draggable={task.status === "todo"}
          dimmed={dragId === task.id}
          hidePeriod={props.hidePeriod === true}
          dropIndicator={drop?.id === task.id ? drop.side : null}
          onDragStart={(event: DragEvent<HTMLLIElement>) => {
            event.dataTransfer.setData(TASK_DRAG_TYPE, task.id);
            event.dataTransfer.setData("text/plain", task.title);
            event.dataTransfer.effectAllowed = "move";
            setDragId(task.id);
          }}
          onDragOver={(event: DragEvent<HTMLLIElement>) => {
            if (!props.reorderable || dragId === null) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const side = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
            if (drop?.id !== task.id || drop.side !== side) setDrop({ id: task.id, side });
          }}
          onDrop={(event: DragEvent<HTMLLIElement>) => {
            if (!props.reorderable) return;
            event.preventDefault();
            onDrop(task, drop?.side ?? "after");
          }}
        />
      ))}
    </ul>
  );
}

export function AddTaskRow(props: {
  readonly label?: string;
  readonly onAdd: (title: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex items-center gap-2.5 py-1.5"
      onSubmit={async (event) => {
        event.preventDefault();
        const title = value.trim();
        if (title.length === 0 || busy) return;
        setBusy(true);
        await props.onAdd(title);
        setBusy(false);
        setValue("");
      }}
    >
      <span
        aria-hidden
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-dashed border-muted-foreground/45"
      />
      <input
        aria-label={props.label ?? "Add a task"}
        placeholder={props.label ?? "Add a task"}
        className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
        value={value}
        maxLength={200}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
      />
    </form>
  );
}

/**
 * Coordinator proposals, set apart from the user's own tasks: dashed boxes,
 * a quiet group label naming who proposed them, Add and dismiss per row.
 */
export function ProposedTasks(props: {
  readonly tasks: ReadonlyArray<Task>;
  readonly context: TaskRowContext;
  readonly variant?: "list" | "card";
  readonly showWorkstream?: boolean;
}) {
  const { tasks, context } = props;
  if (tasks.length === 0) return null;
  const sources = new Set(tasks.map((task) => task.proposal?.projectId));
  const sourceProject =
    sources.size === 1
      ? context.projects.find((p) => p.id === tasks[0]!.proposal?.projectId)
      : null;
  const label =
    props.variant === "card"
      ? "Proposed tasks"
      : sourceProject != null
        ? `Proposed by ${sourceProject.title} coordinator`
        : "Proposed by coordinators";
  const addAll = () => {
    for (const task of tasks) void context.actions.respond(task, true);
  };
  return (
    <section
      aria-label={label}
      className={cn(
        props.variant === "card" && "rounded-xl border border-border bg-card px-4 py-2.5 shadow-xs",
      )}
    >
      <div className="flex items-center gap-1.5 pb-1 text-muted-foreground text-xs">
        {props.variant === "card" ? <ListTodoIcon aria-hidden className="size-3.5" /> : null}
        <span>{label}</span>
        <span className="tabular-nums">{tasks.length}</span>
        {tasks.length > 1 ? (
          <button
            type="button"
            className="ms-auto cursor-pointer font-medium text-foreground hover:underline"
            onClick={addAll}
          >
            Add {tasks.length === 2 ? "both" : "all"}
          </button>
        ) : null}
      </div>
      <ul className="flex flex-col">
        {tasks.map((task) => (
          <ProposedTaskRow
            key={task.id}
            task={task}
            context={context}
            showWorkstream={props.showWorkstream === true}
          />
        ))}
      </ul>
    </section>
  );
}

function ProposedTaskRow(props: {
  readonly task: Task;
  readonly context: TaskRowContext;
  readonly showWorkstream: boolean;
}) {
  const { task, context } = props;
  const project = context.projects.find((p) => p.id === task.links?.projectId);
  const status =
    task.links?.statusId === undefined
      ? undefined
      : project?.assistant?.statuses?.find((s) => s.id === task.links!.statusId);
  return (
    <li className="flex min-w-0 items-center gap-2.5 py-1.5">
      <TaskCheckbox
        checked={false}
        proposed
        label={`Proposed: ${task.title}`}
        onToggle={() => void context.actions.respond(task, true)}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-semibold text-[15px] text-foreground/85">{task.title}</span>
        {props.showWorkstream ? (
          <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <span>{formatTaskHome(task.home, context.today)}</span>
            {status !== undefined ? (
              <span className="inline-flex items-center gap-1">
                <span aria-hidden className="size-1.5 rounded-full bg-emerald-600" />
                {status.title}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
      {!props.showWorkstream ? (
        <span className="shrink-0 text-muted-foreground text-xs">
          {formatTaskHome(task.home, context.today)}
        </span>
      ) : null}
      <button
        type="button"
        aria-label={`Add ${task.title}`}
        className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 font-medium text-xs hover:bg-accent"
        onClick={() => void context.actions.respond(task, true)}
      >
        {props.showWorkstream ? <PlusIcon aria-hidden className="size-3" /> : null}
        Add
      </button>
      <button
        type="button"
        aria-label={`Dismiss ${task.title}`}
        className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => void context.actions.respond(task, false)}
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </li>
  );
}

export function TasksSectionLabel(props: { readonly children: ReactNode }) {
  return <h2 className="pt-5 pb-1 text-muted-foreground text-xs">{props.children}</h2>;
}
