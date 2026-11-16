import { taskCounts } from "@t3tools/client-runtime/state/projects";
import { Link, useRouterState } from "@tanstack/react-router";
import { ListTodoIcon, WifiOffIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useTaskEnvironmentStatus, useTaskToday, useTasks } from "../../state/tasks";
import { useTaskSidebarDropHover } from "./taskDrag";

/**
 * The single Tasks row directly under the Assistant. Its count is what is
 * open today; the ranges live inside the Tasks view. Dropping a dragged task
 * on the row moves it to today: the Tasks page's drag context hit-tests this
 * row (data-task-drop-today, TASK_SIDEBAR_DROP_ATTR) and does the move.
 */
export function SidebarTasksSection(props: {
  /** The shortcut badge shown while the jump modifier is held. */
  readonly hint?: ReactNode;
}) {
  const { environmentId, tasks } = useTasks();
  const today = useTaskToday();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const dropping = useTaskSidebarDropHover();
  const status = useTaskEnvironmentStatus();
  if (environmentId === null) return null;
  // Keep the row while the Tasks server is away; say so instead of vanishing.
  const unavailableLabel =
    status.connected || status.phase === null
      ? null
      : `Tasks are on ${status.remoteLabel ?? "this Mac's server"}, which is reconnecting`;
  const count = taskCounts(tasks, today).today;
  const active = pathname.startsWith("/tasks/");

  return (
    <li className="relative mb-1.5 list-none" data-testid="sidebar-section-tasks">
      <Link
        to="/tasks/$view"
        params={{ view: "today" }}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[length:1em] leading-tight text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-ring",
          active ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
          dropping && "ring-1 ring-primary ring-dashed",
        )}
        data-task-drop-today=""
      >
        <ListTodoIcon aria-hidden className="size-4 text-sidebar-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">Tasks</span>
        {unavailableLabel !== null ? (
          <WifiOffIcon
            aria-label={unavailableLabel}
            data-testid="sidebar-tasks-reconnecting"
            className="size-3.5 text-sidebar-muted-foreground"
          >
            <title>{unavailableLabel}</title>
          </WifiOffIcon>
        ) : null}
        {count > 0 ? (
          <span
            className="text-sidebar-muted-foreground text-xs tabular-nums"
            aria-label={`${count} open today`}
          >
            {count}
          </span>
        ) : null}
      </Link>
      {props.hint}
    </li>
  );
}
