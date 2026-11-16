import type { Task } from "@t3tools/contracts";

// Fork-owned. Check-off on iPhone and iPad, matching Lucive mobile
// (lucive/mobile/src/screens/planning/TodayScreen.tsx:95-148, the same in
// PeriodScreen.tsx:101-177):
// - The completion is written immediately on tap (handleToggle awaits
//   toggleTaskCompletion, TodayScreen.tsx:141-148). No delay before the write.
// - The row then lingers in the open list, checked and struck through
//   (TaskRow.tsx:56-60, 94-96: inkSoft colour + line-through), for 1000ms
//   (lingerTask's setTimeout, TodayScreen.tsx:109-116) before the list drops it.
// - No animation: no fade, no height collapse; the row is simply filtered out.
// - Unchecking during the linger reopens the task at once (a plain toggle);
//   the row stays because it is open again.
// - Lucive mobile shows no Undo for a check-off (its UndoToast is only for
//   bulk delete, TodayScreen.tsx:350-354). Control Plane keeps its Undo banner.

/** How long a checked-off row stays in its list before it leaves. */
export const CHECK_OFF_LINGER_MS = 1000;

/**
 * The tasks the open lists are built from: a task checked off within the
 * linger window still counts as open, so it keeps its place until the window
 * ends. Rows render the real task (checked) by id.
 */
export function withLingeringTasks(
  tasks: ReadonlyArray<Task>,
  lingering: ReadonlySet<string>,
): ReadonlyArray<Task> {
  if (lingering.size === 0) return tasks;
  return tasks.map((task) =>
    lingering.has(task.id) && task.status === "completed" ? { ...task, status: "todo" } : task,
  );
}
