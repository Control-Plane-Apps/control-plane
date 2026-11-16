import {
  taskRecurrenceEnd,
  withTaskRecurrenceCadence,
  withTaskRecurrenceEnd,
  type TaskMoveTarget,
  type TaskRecurrenceEnd,
} from "@t3tools/client-runtime/state/projects";
import { addTaskDays, taskPeriodFor, taskWeekday, type TaskRecurrence } from "@t3tools/contracts";

// Fork-owned. The same Remind and Repeat choices as the desktop task menus.

export const REMINDER_TIMES: ReadonlyArray<string> = [
  "08:00",
  "09:00",
  "12:00",
  "15:00",
  "17:00",
  "20:00",
];

export const REPEAT_OPTIONS: ReadonlyArray<{
  readonly label: string;
  readonly value: TaskRecurrence | null;
}> = [
  { label: "Does not repeat", value: null },
  { label: "Daily", value: { frequency: "daily", interval: 1 } },
  { label: "Weekly", value: { frequency: "weekly", interval: 1 } },
  { label: "Every 2 weeks", value: { frequency: "weekly", interval: 2 } },
  { label: "Monthly", value: { frequency: "monthly", interval: 1 } },
];

/** How a series ends, offered beside the cadence once a task repeats. */
export function repeatEndOptions(
  today: string,
): ReadonlyArray<{ readonly label: string; readonly end: TaskRecurrenceEnd }> {
  return [
    { label: "Never ends", end: { kind: "never" } },
    { label: "Ends after 5 times", end: { kind: "count", count: 5 } },
    { label: "Ends after 10 times", end: { kind: "count", count: 10 } },
    { label: "Ends after 30 times", end: { kind: "count", count: 30 } },
    { label: "Ends this month", end: { kind: "date", date: taskPeriodFor("month", today).endsOn } },
    { label: "Ends this year", end: { kind: "date", date: taskPeriodFor("year", today).endsOn } },
  ];
}

/** The Repeat menu's actions: cadences, then how the series ends when it repeats. */
export function repeatMenuActions(
  current: TaskRecurrence | null | undefined,
  today: string,
): ReadonlyArray<{ readonly id: string; readonly title: string; readonly state?: "on" | "off" }> {
  const cadences = REPEAT_OPTIONS.map((option) => ({ id: option.label, title: option.label }));
  if (current == null) return cadences;
  const end = JSON.stringify(taskRecurrenceEnd(current));
  return [
    ...cadences,
    ...repeatEndOptions(today).map((option) => ({
      id: option.label,
      title: option.label,
      state: JSON.stringify(option.end) === end ? ("on" as const) : ("off" as const),
    })),
  ];
}

/** The repeat rule after picking `id` from repeatMenuActions. */
export function repeatMenuChoice(
  current: TaskRecurrence | null | undefined,
  id: string,
  today: string,
): TaskRecurrence | null {
  const end = repeatEndOptions(today).find((option) => option.label === id);
  if (end !== undefined) return current == null ? null : withTaskRecurrenceEnd(current, end.end);
  const cadence = REPEAT_OPTIONS.find((option) => option.label === id)?.value ?? null;
  return withTaskRecurrenceCadence(current, cadence);
}

// The Move sheet: a day, a commitment, or a backlog.

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface MoveEntry {
  readonly label: string;
  readonly hint?: string;
  readonly icon: "calendar" | "tray";
  readonly target: TaskMoveTarget;
}

/** Saturday of this weekend; today when it already is the weekend. */
export function weekendDate(today: string): string {
  const weekday = taskWeekday(today);
  if (weekday === 6 || weekday === 0) return today;
  return addTaskDays(today, 6 - weekday);
}

/** Monday of next week. */
export function nextWeekDate(today: string): string {
  const weekday = taskWeekday(today);
  return addTaskDays(today, (8 - weekday) % 7 || 7);
}

export function moveSections(today: string): ReadonlyArray<{
  readonly title: string | null;
  readonly entries: ReadonlyArray<MoveEntry>;
}> {
  const tomorrow = addTaskDays(today, 1);
  return [
    {
      title: null,
      entries: [
        { label: "Today", icon: "calendar", target: { kind: "today" } },
        {
          label: "Tomorrow",
          hint: WEEKDAYS_SHORT[taskWeekday(tomorrow)],
          icon: "calendar",
          target: { kind: "tomorrow" },
        },
        {
          label: "This weekend",
          icon: "calendar",
          target: { kind: "date", date: weekendDate(today) },
        },
        {
          label: "Next week",
          hint: "Mon",
          icon: "calendar",
          target: { kind: "date", date: nextWeekDate(today) },
        },
      ],
    },
    {
      title: "Commit",
      entries: [
        { label: "This week", icon: "tray", target: { kind: "commit", horizon: "week" } },
        { label: "This month", icon: "tray", target: { kind: "commit", horizon: "month" } },
        { label: "This year", icon: "tray", target: { kind: "commit", horizon: "year" } },
      ],
    },
    {
      title: "Backlog",
      entries: [
        { label: "General backlog", icon: "tray", target: { kind: "backlog", horizon: null } },
        { label: "Week backlog", icon: "tray", target: { kind: "backlog", horizon: "week" } },
        { label: "Month backlog", icon: "tray", target: { kind: "backlog", horizon: "month" } },
        { label: "Year backlog", icon: "tray", target: { kind: "backlog", horizon: "year" } },
      ],
    },
  ];
}
