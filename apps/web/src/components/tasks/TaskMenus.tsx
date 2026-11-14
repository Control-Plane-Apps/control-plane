import type { TaskHome, TaskRecurrence } from "@t3tools/contracts";
import {
  formatTaskHome,
  formatTaskRecurrence,
  formatTaskRecurrenceCadence,
  isHomeAtTarget,
  taskRecurrenceEnd,
  withTaskRecurrenceCadence,
  withTaskRecurrenceEnd,
  type TaskMoveTarget,
} from "@t3tools/client-runtime/state/projects";
import { TASK_RECURRENCE_COUNT_MAX } from "@t3tools/contracts";
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
  const { recurrence } = props;
  const current = recurrence === undefined ? null : formatTaskRecurrenceCadence(recurrence);
  const end = recurrence === undefined ? null : taskRecurrenceEnd(recurrence);
  const mark = (on: boolean) => (
    <CheckIcon aria-hidden className={cn("size-3.5 shrink-0", on ? "opacity-100" : "opacity-0")} />
  );
  return (
    <Menu>
      <MenuTrigger
        className={props.className}
        disabled={props.disabled}
        aria-label={
          recurrence === undefined ? "Repeat" : `Repeats ${formatTaskRecurrence(recurrence)}`
        }
      >
        {props.children}
      </MenuTrigger>
      <MenuPopup align="start" className="w-52">
        {REPEAT_OPTIONS.map((option) => {
          const label = option.value === null ? null : formatTaskRecurrenceCadence(option.value);
          return (
            <MenuItem
              key={option.label}
              onClick={() => props.onChange(withTaskRecurrenceCadence(recurrence, option.value))}
            >
              <span className="flex w-full items-center gap-2">
                {mark(label === current)}
                {option.label}
              </span>
            </MenuItem>
          );
        })}
        {recurrence !== undefined && end !== null ? (
          <MenuGroup>
            <MenuSeparator />
            <div className="px-2 py-1 text-muted-foreground text-xs">Ends</div>
            <MenuItem
              onClick={() => props.onChange(withTaskRecurrenceEnd(recurrence, { kind: "never" }))}
            >
              <span className="flex w-full items-center gap-2">
                {mark(end.kind === "never")}
                Never
              </span>
            </MenuItem>
            <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm hover:bg-accent">
              {mark(end.kind === "count")}
              <span className="flex-1">After</span>
              <input
                type="number"
                min={1}
                max={TASK_RECURRENCE_COUNT_MAX}
                aria-label="Number of times"
                className="w-12 rounded border bg-transparent px-1 text-right"
                defaultValue={end.kind === "count" ? end.count : ""}
                onKeyDown={(event) => event.stopPropagation()}
                onChange={(event) => {
                  const count = Number(event.target.value);
                  if (Number.isInteger(count) && count >= 1 && count <= TASK_RECURRENCE_COUNT_MAX) {
                    props.onChange(withTaskRecurrenceEnd(recurrence, { kind: "count", count }));
                  }
                }}
              />
              <span>times</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm hover:bg-accent">
              {mark(end.kind === "date")}
              <span className="flex-1">On</span>
              <input
                type="date"
                aria-label="End date"
                className="cursor-pointer bg-transparent"
                value={end.kind === "date" ? end.date : ""}
                onChange={(event) => {
                  if (event.target.value) {
                    props.onChange(
                      withTaskRecurrenceEnd(recurrence, { kind: "date", date: event.target.value }),
                    );
                  }
                }}
              />
            </label>
          </MenuGroup>
        ) : null}
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
