import {
  homeForMove,
  taskCounts,
  type TaskMoveTarget,
} from "@t3tools/client-runtime/state/projects";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useState, type DragEvent } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { cn } from "../../lib/utils";
import { useTaskToday, useTasks } from "../../state/tasks";
import { openTaskQuickAdd } from "./QuickAddDialog";
import { TASK_DRAG_TYPE } from "./TaskRow";
import type { TasksView } from "./TasksPage";
import { useTaskActions } from "./useTaskActions";

const useTasksSectionStore = create<{
  readonly expanded: boolean;
  readonly toggle: () => void;
}>()(
  persist(
    (set) => ({
      expanded: true,
      toggle: () => set((state) => ({ expanded: !state.expanded })),
    }),
    { name: "cplane:sidebar-tasks-section:v1" },
  ),
);

const ROWS: ReadonlyArray<{
  readonly view: TasksView;
  readonly label: string;
  readonly drop?: TaskMoveTarget;
}> = [
  { view: "today", label: "Today", drop: { kind: "today" } },
  { view: "week", label: "Week", drop: { kind: "commit", horizon: "week" } },
  { view: "month", label: "Month", drop: { kind: "commit", horizon: "month" } },
  { view: "year", label: "Year", drop: { kind: "commit", horizon: "year" } },
  { view: "upcoming", label: "Upcoming" },
  { view: "all", label: "All tasks" },
];

/**
 * Tasks as a top-level sidebar destination above Projects: Today, Week,
 * Month, Year, Upcoming and All tasks. Dropping a dragged task on Today or a
 * horizon moves it there.
 */
export function SidebarTasksSection() {
  const { environmentId, tasks } = useTasks();
  const today = useTaskToday();
  const actions = useTaskActions(environmentId);
  const expanded = useTasksSectionStore((state) => state.expanded);
  const toggle = useTasksSectionStore((state) => state.toggle);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [dropView, setDropView] = useState<TasksView | null>(null);
  if (environmentId === null) return null;
  const counts = taskCounts(tasks, today);
  const countFor = (view: TasksView): number | null =>
    view === "today" || view === "week" || view === "month" || view === "year"
      ? counts[view] || null
      : null;

  const onDrop = (event: DragEvent, target: TaskMoveTarget) => {
    setDropView(null);
    const taskId = event.dataTransfer.getData(TASK_DRAG_TYPE);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) return;
    event.preventDefault();
    void actions.move(task, homeForMove(target, task.home, today));
  };

  return (
    <li className="list-none w-full" data-testid="sidebar-section-tasks">
      <div className="group/section flex h-7 w-full items-center gap-0.5 px-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} Tasks`}
          className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={toggle}
        >
          <span className="min-w-0 truncate text-[length:1em] leading-tight text-sidebar-muted-foreground/65 dark:text-sidebar-muted-foreground">
            Tasks
          </span>
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-sidebar-muted-foreground/65 transition-[opacity,transform] duration-150",
              expanded && "rotate-90",
              expanded
                ? "opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100"
                : "opacity-100",
            )}
          />
          {!expanded && counts.today > 0 ? (
            <span className="ms-auto me-1 text-sidebar-muted-foreground text-xs tabular-nums">
              {counts.today} today
            </span>
          ) : null}
        </button>
        <button
          type="button"
          aria-label="Add task"
          className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => openTaskQuickAdd()}
        >
          <PlusIcon aria-hidden className="size-3.5" />
        </button>
      </div>
      {expanded ? (
        <ul className="flex flex-col px-1 pb-2">
          {ROWS.map((row) => {
            const active = pathname === `/tasks/${row.view}`;
            const count = countFor(row.view);
            return (
              <li key={row.view} className="list-none">
                {row.view === "upcoming" ? (
                  <div aria-hidden className="mx-2 my-1 h-px bg-sidebar-border" />
                ) : null}
                <Link
                  to="/tasks/$view"
                  params={{ view: row.view }}
                  className={cn(
                    "flex h-7 items-center gap-2 rounded-md px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "bg-sidebar-row-active text-sidebar-foreground"
                      : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover",
                    dropView === row.view && "ring-1 ring-primary ring-dashed",
                  )}
                  onDragOver={
                    row.drop === undefined
                      ? undefined
                      : (event) => {
                          if (!event.dataTransfer.types.includes(TASK_DRAG_TYPE)) return;
                          event.preventDefault();
                          if (dropView !== row.view) setDropView(row.view);
                        }
                  }
                  onDragLeave={() =>
                    setDropView((current) => (current === row.view ? null : current))
                  }
                  onDrop={row.drop === undefined ? undefined : (event) => onDrop(event, row.drop!)}
                >
                  <span className="flex-1 truncate">{row.label}</span>
                  {count !== null ? (
                    <span className="text-sidebar-muted-foreground text-xs tabular-nums">
                      {count}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
