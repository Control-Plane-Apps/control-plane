import type { TaskRecurrence } from "@t3tools/contracts";

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
