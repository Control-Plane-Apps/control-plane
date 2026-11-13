import type { TaskHome, TaskRecurrence } from "@t3tools/contracts";
import {
  formatTaskHome,
  formatTaskRecurrence,
  isHomeAtTarget,
  type TaskMoveTarget,
} from "@t3tools/client-runtime/state/projects";
import { addTaskDays, taskWeekday } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Menu, MenuGroup, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type MoveEntry = {
  readonly label: string;
  readonly hint?: string;
  readonly target: TaskMoveTarget;
};

/** The Move menu: a day, a commitment, or a backlog. One home per task. */
export function moveEntries(today: string): ReadonlyArray<ReadonlyArray<MoveEntry>> {
  const tomorrow = addTaskDays(today, 1);
  return [
    [
      { label: "Today", target: { kind: "today" } },
      {
        label: "Tomorrow",
        hint: WEEKDAYS_SHORT[taskWeekday(tomorrow)]!,
        target: { kind: "tomorrow" },
      },
    ],
    [
      { label: "This week", target: { kind: "commit", horizon: "week" } },
      { label: "This month", target: { kind: "commit", horizon: "month" } },
      { label: "This year", target: { kind: "commit", horizon: "year" } },
    ],
    [
      { label: "General backlog", target: { kind: "backlog", horizon: null } },
      { label: "Week backlog", target: { kind: "backlog", horizon: "week" } },
      { label: "Month backlog", target: { kind: "backlog", horizon: "month" } },
      { label: "Year backlog", target: { kind: "backlog", horizon: "year" } },
    ],
  ];
}

export function TaskMoveMenu(props: {
  readonly home: TaskHome;
  readonly today: string;
  readonly onMove: (target: TaskMoveTarget) => void;
  readonly onPickDate: (date: string) => void;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const groups = moveEntries(props.today);
  return (
    <Menu>
      <MenuTrigger
        className={props.className}
        aria-label={`Move task, now ${formatTaskHome(props.home, props.today)}`}
      >
        {props.children}
      </MenuTrigger>
      <MenuPopup align="start" className="w-48">
        {groups.map((group, index) => (
          <MenuGroup key={group[0]!.label}>
            {index > 0 ? <MenuSeparator /> : null}
            {group.map((entry) => {
              const checked = isHomeAtTarget(props.home, entry.target, props.today);
              return (
                <MenuItem key={entry.label} onClick={() => props.onMove(entry.target)}>
                  <span className="flex w-full items-center gap-2">
                    <CheckIcon
                      aria-hidden
                      className={cn("size-3.5 shrink-0", checked ? "opacity-100" : "opacity-0")}
                    />
                    <span className="flex-1">{entry.label}</span>
                    {entry.hint !== undefined ? (
                      <span className="text-muted-foreground text-xs">{entry.hint}</span>
                    ) : null}
                  </span>
                </MenuItem>
              );
            })}
            {index === 0 ? (
              <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm hover:bg-accent">
                <span aria-hidden className="size-3.5 shrink-0" />
                <span className="flex-1">Pick a date</span>
                <input
                  type="date"
                  aria-label="Pick a date"
                  className="w-5 cursor-pointer opacity-60"
                  value={props.home.kind === "date" ? props.home.date : ""}
                  onChange={(event) => {
                    if (event.target.value) props.onPickDate(event.target.value);
                  }}
                />
              </label>
            ) : null}
          </MenuGroup>
        ))}
      </MenuPopup>
    </Menu>
  );
}

const REPEAT_OPTIONS: ReadonlyArray<{
  readonly label: string;
  readonly value: TaskRecurrence | null;
}> = [
  { label: "Does not repeat", value: null },
  { label: "Daily", value: { frequency: "daily", interval: 1 } },
  { label: "Weekly", value: { frequency: "weekly", interval: 1 } },
  { label: "Every 2 weeks", value: { frequency: "weekly", interval: 2 } },
  { label: "Monthly", value: { frequency: "monthly", interval: 1 } },
];

export function TaskRepeatMenu(props: {
  readonly recurrence: TaskRecurrence | undefined;
  readonly disabled?: boolean;
  readonly onChange: (value: TaskRecurrence | null) => void;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const current = props.recurrence === undefined ? null : formatTaskRecurrence(props.recurrence);
  return (
    <Menu>
      <MenuTrigger
        className={props.className}
        disabled={props.disabled}
        aria-label={current === null ? "Repeat" : `Repeats ${current}`}
      >
        {props.children}
      </MenuTrigger>
      <MenuPopup align="start" className="w-44">
        {REPEAT_OPTIONS.map((option) => {
          const label = option.value === null ? null : formatTaskRecurrence(option.value);
          const checked = label === current;
          return (
            <MenuItem key={option.label} onClick={() => props.onChange(option.value)}>
              <span className="flex w-full items-center gap-2">
                <CheckIcon
                  aria-hidden
                  className={cn("size-3.5 shrink-0", checked ? "opacity-100" : "opacity-0")}
                />
                {option.label}
              </span>
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}

const REMINDER_TIMES = ["08:00", "09:00", "12:00", "15:00", "17:00", "20:00"];

export function TaskReminderMenu(props: {
  readonly time: string | undefined;
  readonly onChange: (time: string | null) => void;
  readonly children: ReactNode;
  readonly className?: string;
  readonly formatTime: (time: string) => string;
}) {
  return (
    <Menu>
      <MenuTrigger className={props.className} aria-label="Remind">
        {props.children}
      </MenuTrigger>
      <MenuPopup align="start" className="w-40">
        {REMINDER_TIMES.map((time) => (
          <MenuItem key={time} onClick={() => props.onChange(time)}>
            <span className="flex w-full items-center gap-2">
              <CheckIcon
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0",
                  props.time === time ? "opacity-100" : "opacity-0",
                )}
              />
              {props.formatTime(time)}
            </span>
          </MenuItem>
        ))}
        <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm hover:bg-accent">
          <span aria-hidden className="size-3.5 shrink-0" />
          <span className="flex-1">Other</span>
          <input
            type="time"
            aria-label="Reminder time"
            className="w-5 cursor-pointer opacity-60"
            value={props.time ?? ""}
            onChange={(event) => {
              if (event.target.value) props.onChange(event.target.value);
            }}
          />
        </label>
        {props.time !== undefined ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => props.onChange(null)}>No reminder</MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
