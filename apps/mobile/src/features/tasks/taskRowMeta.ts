import {
  formatTaskHome,
  formatTaskRecurrence,
  formatTaskTime,
} from "@t3tools/client-runtime/state/projects";
import type { Task } from "@t3tools/contracts";

/** What the row says about where the task lives: time today, overdue day, repeat, period. */
export function taskRowMeta(
  task: Task,
  today: string,
  hidePeriod: boolean,
  hideDay = false,
): string | null {
  if (task.recurrence !== undefined) return formatTaskRecurrence(task.recurrence);
  if (hidePeriod && task.home.kind === "period") return null;
  // Today, or a row already inside its day's section: only the time is news.
  if (task.home.kind === "date" && (hideDay || task.home.date === today)) {
    return task.home.reminderTime !== undefined ? formatTaskTime(task.home.reminderTime) : null;
  }
  return formatTaskHome(task.home, today);
}
