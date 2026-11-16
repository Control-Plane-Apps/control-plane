import { todayTasks } from "@t3tools/client-runtime/state/projects";
import type { Task } from "@t3tools/contracts";

// Fork-owned. Which of today's tasks the Assistant rail lists.

/** Rows the rail shows before "+N more". */
export const RAIL_TASKS_LIMIT = 8;

/**
 * Open tasks due today or earlier, overdue first, each part in the user's
 * own order; the rest past the cap is counted, not shown.
 */
export function railTodayTasks(
  tasks: ReadonlyArray<Task>,
  today: string,
  limit: number = RAIL_TASKS_LIMIT,
): { readonly shown: ReadonlyArray<Task>; readonly more: number; readonly total: number } {
  const due = todayTasks(tasks, today);
  const isOverdue = (task: Task) => task.home.kind === "date" && task.home.date < today;
  const ordered = [...due.filter(isOverdue), ...due.filter((task) => !isOverdue(task))];
  return {
    shown: ordered.slice(0, limit),
    more: Math.max(0, ordered.length - limit),
    total: ordered.length,
  };
}
