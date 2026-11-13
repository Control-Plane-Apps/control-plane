/**
 * Which task reminders are due, on the Mac's local clock, the same rule the
 * desktop's TaskReminderCoordinator uses. Fork-owned and pure.
 *
 * @module taskReminders
 */
import { isProposedTask, type Task } from "@t3tools/contracts";

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

export function taskReminderKey(task: Task): string | null {
  return task.home.kind === "date" && task.home.reminderTime !== undefined
    ? `${task.id}@${task.home.date}T${task.home.reminderTime}`
    : null;
}

/** Open tasks on today whose reminder time arrived within the grace window and was not sent. */
export function dueTaskReminders(
  tasks: Iterable<Task>,
  nowMs: number,
  sent: ReadonlySet<string>,
): Task[] {
  const clock = localClock(nowMs);
  const today = clock.date;
  const nowMinutes = minutesOf(clock.time);
  const due: Task[] = [];
  for (const task of tasks) {
    if (task.status !== "todo" || isProposedTask(task) || task.home.kind !== "date") continue;
    const time = task.home.reminderTime;
    if (task.home.date !== today || time === undefined) continue;
    const late = nowMinutes - minutesOf(time);
    if (late < 0 || late > TASK_REMINDER_GRACE_MINUTES) continue;
    const key = taskReminderKey(task);
    if (key !== null && !sent.has(key)) due.push(task);
  }
  return due;
}
