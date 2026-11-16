import { homeForMove, taskCounts } from "@t3tools/client-runtime/state/projects";
import { Link, useRouterState } from "@tanstack/react-router";
import { ListTodoIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useTaskToday, useTasks } from "../../state/tasks";
import { TASK_DRAG_TYPE } from "./TaskRow";
import { useTaskActions } from "./useTaskActions";

/**
 * The single Tasks row directly under the Assistant. Its count is what is
 * open today; the ranges live inside the Tasks view. Dropping a dragged task
 * on the row moves it to today.
 */
export function SidebarTasksSection() {
  const { environmentId, tasks } = useTasks();
  const today = useTaskToday();
  const actions = useTaskActions(environmentId);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [dropping, setDropping] = useState(false);
  if (environmentId === null) return null;
  const count = taskCounts(tasks, today).today;
  const active = pathname.startsWith("/tasks/");

  return (
    <li className="mb-1.5 list-none" data-testid="sidebar-section-tasks">
      <Link
        to="/tasks/$view"
        params={{ view: "today" }}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[length:1em] leading-tight text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-ring",
          active ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
          dropping && "ring-1 ring-primary ring-dashed",
        )}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(TASK_DRAG_TYPE)) return;
          event.preventDefault();
          if (!dropping) setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          setDropping(false);
          const taskId = event.dataTransfer.getData(TASK_DRAG_TYPE);
          const task = tasks.find((candidate) => candidate.id === taskId);
          if (task === undefined) return;
          event.preventDefault();
          void actions.move(task, homeForMove({ kind: "today" }, task.home, today));
        }}
      >
        <ListTodoIcon aria-hidden className="size-4 text-sidebar-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">Tasks</span>
        {count > 0 ? (
          <span
            className="text-sidebar-muted-foreground text-xs tabular-nums"
            aria-label={`${count} open today`}
          >
            {count}
          </span>
        ) : null}
      </Link>
    </li>
  );
}
