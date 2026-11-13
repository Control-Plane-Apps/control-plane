import { isProposedTask, type Task } from "@t3tools/contracts";

/**
 * Fork-owned. Which task reminders are due: open tasks on `today` whose local
 * reminder time (`HH:MM`) has arrived and was not fired yet. Shared by the
 * desktop's reminder toasts and the Mac server's iPhone reminders.
 */
export function dueTaskReminders(
  tasks: Iterable<Task>,
  today: string,
  time: string,
  fired: ReadonlySet<string>,
): Task[] {
  const due: Task[] = [];
  for (const task of tasks) {
    if (
      task.status === "todo" &&
      !isProposedTask(task) &&
      task.home.kind === "date" &&
      task.home.date === today &&
      task.home.reminderTime !== undefined &&
      task.home.reminderTime <= time &&
      !fired.has(taskReminderKey(task)!)
    ) {
      due.push(task);
    }
  }
  return due;
}

/** `<taskId>@<date>T<HH:MM>`: one reminder of one task on one day. */
export function taskReminderKey(task: Task): string | null {
  return task.home.kind === "date" && task.home.reminderTime !== undefined
    ? `${task.id}@${task.home.date}T${task.home.reminderTime}`
    : null;
}
