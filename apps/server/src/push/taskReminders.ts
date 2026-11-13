/**
 * Which task reminders are due on the Mac's local clock: the desktop's rule
 * (@t3tools/shared/taskReminders) plus a grace window. Fork-owned and pure.
 *
 * @module taskReminders
 */
import type { Task } from "@t3tools/contracts";
import {
  dueTaskReminders as sharedDueTaskReminders,
  taskReminderKey,
} from "@t3tools/shared/taskReminders";

/** A reminder this late is dropped rather than sent (the Mac was asleep or off). */
export const TASK_REMINDER_GRACE_MINUTES = 30;

const LOCAL_PARTS = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** The Mac's local wall clock: `YYYY-MM-DD` and `HH:MM`. */
export function localClock(nowMs: number): { readonly date: string; readonly time: string } {
  const parts = Object.fromEntries(
    LOCAL_PARTS.formatToParts(nowMs).map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function minutesOf(hhmm: string): number {
  const [hours = 0, minutes = 0] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

export { taskReminderKey };

/** Reminders due now that are still within the grace window. */
export function dueTaskReminders(
  tasks: Iterable<Task>,
  nowMs: number,
  sent: ReadonlySet<string>,
): Task[] {
  const clock = localClock(nowMs);
  const nowMinutes = minutesOf(clock.time);
  return sharedDueTaskReminders(tasks, clock.date, clock.time, sent).filter(
    (task) =>
      task.home.kind === "date" &&
      task.home.reminderTime !== undefined &&
      nowMinutes - minutesOf(task.home.reminderTime) <= TASK_REMINDER_GRACE_MINUTES,
  );
}
