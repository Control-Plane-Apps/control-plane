import type { TaskMoveTarget } from "@t3tools/client-runtime/state/projects";
import { addTaskDays, taskWeekday, type TaskRecurrence } from "@t3tools/contracts";

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
