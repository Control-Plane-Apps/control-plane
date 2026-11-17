import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectStatusId } from "./projectStatus.ts";

// Fork-owned. Personal tasks that live beside agent work: one global list,
// optionally linked to a Project, a thread or a Status workstream. The shape
// follows Lucive's task model (title, notes, todo/completed/cancelled, one
// "home" per task, recurrence, manual order) so a later import maps 1:1.
// Imports only baseSchemas and projectStatus so orchestration.ts can embed it.

export const TASK_TITLE_MAX = 200;
export const TASK_NOTES_MAX = 4000;
export const TASK_INTENT_MAX = 280;
/** Proposed tasks one coordinator may have waiting at once. */
export const TASK_PROPOSALS_PER_PROJECT_MAX = 10;

export const TaskId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("TaskId"),
);
export type TaskId = typeof TaskId.Type;

/** A calendar day in the user's own time zone, `YYYY-MM-DD`. */
export const TaskLocalDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
export type TaskLocalDate = typeof TaskLocalDate.Type;

/** A 24h local wall-clock time, `HH:MM`. */
export const TaskTimeOfDay = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));
export type TaskTimeOfDay = typeof TaskTimeOfDay.Type;

export const TaskStatus = Schema.Literals(["todo", "completed", "cancelled"]);
export type TaskStatus = typeof TaskStatus.Type;

export const TaskHorizon = Schema.Literals(["week", "month", "year"]);
export type TaskHorizon = typeof TaskHorizon.Type;

/**
 * Where a task lives. Exactly one home, so a task is never in two places:
 * a day (optionally with a reminder), a commitment to one week / month /
 * year, or a backlog (a horizon's backlog, or the general backlog when
 * `horizon` is null).
 */
export const TaskHome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("date"),
    date: TaskLocalDate,
    reminderTime: Schema.optional(TaskTimeOfDay),
  }),
  Schema.Struct({
    kind: Schema.Literal("period"),
    horizon: TaskHorizon,
    startsOn: TaskLocalDate,
    endsOn: TaskLocalDate,
  }),
  Schema.Struct({
    kind: Schema.Literal("backlog"),
    horizon: Schema.NullOr(TaskHorizon),
  }),
]);
export type TaskHome = typeof TaskHome.Type;

/** The most occurrences a series may be limited to. */
export const TASK_RECURRENCE_COUNT_MAX = 999;

export const TaskRecurrence = Schema.Struct({
  frequency: Schema.Literals(["daily", "weekly", "monthly"]),
  /** Every N days / weeks / months. */
  interval: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 })),
  /** 0-6, Sunday first. Weekly only; absent means the anchor day's weekday. */
  daysOfWeek: Schema.optional(
    Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
  ),
  /** 1-31. Monthly only; absent means the anchor day's date. */
  dayOfMonth: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 }))),
  /**
   * The series ends after this many occurrences, counted like Lucive: live
   * occurrences only, so a skipped (deleted) one does not count.
   */
  endAfterCount: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: TASK_RECURRENCE_COUNT_MAX })),
  ),
  /** No occurrence is opened after this day, YYYY-MM-DD. */
  endAfterDate: Schema.optional(TaskLocalDate),
  /**
   * Which live occurrence of the series this is, 1-based. Kept by Control
   * Plane (and filled from the synced series) only while `endAfterCount` is
   * set; any value a client sends is replaced.
   */
  occurrence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type TaskRecurrence = typeof TaskRecurrence.Type;

/** How a delete treats a repeating task: skip this occurrence, or stop the series. */
export const TaskDeleteScope = Schema.Literals(["occurrence", "series"]);
export type TaskDeleteScope = typeof TaskDeleteScope.Type;

/** What a task is about. A workstream link always names its Project. */
export const TaskLinks = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  statusId: Schema.optional(ProjectStatusId),
});
export type TaskLinks = typeof TaskLinks.Type;

/**
 * A coordinator proposed this task. It waits for the user (`acceptedAt`
 * absent) until they add it, or dismiss it, which deletes it.
 */
export const TaskProposal = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  proposedAt: IsoDateTime,
  acceptedAt: Schema.optional(IsoDateTime),
});
export type TaskProposal = typeof TaskProposal.Type;

/** The user handed this task to a coordinator or a new agent as its brief. */
export const TaskHandoff = Schema.Struct({
  kind: Schema.Literals(["coordinator", "agent"]),
  threadId: ThreadId,
  at: IsoDateTime,
});
export type TaskHandoff = typeof TaskHandoff.Type;

/** Where an imported task came from, so a re-run of an import skips it. */
export const TaskImportSource = Schema.Struct({
  kind: Schema.Literal("lucive"),
  id: TrimmedNonEmptyString,
});
export type TaskImportSource = typeof TaskImportSource.Type;

export const TASK_ORDER_KEY_MAX_LENGTH = 64;
/** Same fractional-index alphabet as Project order keys. */
export const TaskOrderKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(TASK_ORDER_KEY_MAX_LENGTH),
  Schema.isPattern(/^[a-z]*[b-z]$/),
);
export type TaskOrderKey = typeof TaskOrderKey.Type;

export const Task = Schema.Struct({
  id: TaskId,
  title: TrimmedNonEmptyString,
  notes: Schema.optional(TrimmedNonEmptyString),
  status: TaskStatus,
  home: TaskHome,
  recurrence: Schema.optional(TaskRecurrence),
  /** Null or absent sorts after arranged tasks, oldest first. */
  orderKey: Schema.optional(Schema.NullOr(TaskOrderKey)),
  links: Schema.optional(TaskLinks),
  proposal: Schema.optional(TaskProposal),
  handoff: Schema.optional(TaskHandoff),
  /**
   * The user answered "Not yet" to completing this task when its linked
   * workstream finished. The prompt stays hidden until the workstream is
   * written again after this time.
   */
  completionPromptDismissedAt: Schema.optional(IsoDateTime),
  completedAt: Schema.optional(IsoDateTime),
  importSource: Schema.optional(TaskImportSource),
  /**
   * The synced repeating series this occurrence belongs to (opaque id). The
   * next occurrence a completion opens keeps it, so it joins the same series.
   */
  seriesId: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Task = typeof Task.Type;

/** The user's one-line intent for a week, month or year. */
export const TaskIntent = Schema.Struct({
  horizon: TaskHorizon,
  startsOn: TaskLocalDate,
  text: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});
export type TaskIntent = typeof TaskIntent.Type;

/** Stable key for an intent's period, also its aggregate id. */
export function taskIntentKey(horizon: TaskHorizon, startsOn: string): TaskId {
  return `intent-${horizon}-${startsOn}` as TaskId;
}

/** The fields a user edit may change. Absent keeps; null clears. */
export const TaskPatch = Schema.Struct({
  title: Schema.optional(TrimmedNonEmptyString),
  /** Empty string clears. */
  notes: Schema.optional(Schema.String),
  home: Schema.optional(TaskHome),
  recurrence: Schema.optional(Schema.NullOr(TaskRecurrence)),
  links: Schema.optional(Schema.NullOr(TaskLinks)),
  orderKey: Schema.optional(Schema.NullOr(TaskOrderKey)),
  status: Schema.optional(TaskStatus),
  completionPromptDismissedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type TaskPatch = typeof TaskPatch.Type;

export function isProposedTask(task: Pick<Task, "proposal">): boolean {
  return task.proposal !== undefined && task.proposal.acceptedAt === undefined;
}

/** Arranged tasks by key, then keyless tasks oldest first. */
export function compareTaskOrder(
  left: Pick<Task, "orderKey" | "createdAt" | "id">,
  right: Pick<Task, "orderKey" | "createdAt" | "id">,
): number {
  const leftKey = left.orderKey ?? null;
  const rightKey = right.orderKey ?? null;
  if (leftKey !== null && rightKey !== null && leftKey !== rightKey) {
    return leftKey < rightKey ? -1 : 1;
  }
  if (leftKey !== null && rightKey === null) return -1;
  if (leftKey === null && rightKey !== null) return 1;
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function parseLocalDate(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return { y, m, d };
}

// Civil-date arithmetic on day numbers (days since 1970-01-01), so no time
// zone or Date object is involved.
function daysFromCivil(y: number, m: number, d: number): number {
  const year = m <= 2 ? y - 1 : y;
  const era = Math.floor(year / 400);
  const yoe = year - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): { y: number; m: number; d: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

function formatCivil(y: number, m: number, d: number): TaskLocalDate {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Normalizes an out-of-range month (any integer) and day >= 1 overflow. */
function civil(y: number, m: number, d: number): TaskLocalDate {
  const totalMonths = y * 12 + (m - 1);
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths - year * 12 + 1;
  const { y: ny, m: nm, d: nd } = civilFromDays(daysFromCivil(year, month, 1) + d - 1);
  return formatCivil(ny, nm, nd);
}

function daysInMonth(y: number, m: number): number {
  const next = m === 12 ? daysFromCivil(y + 1, 1, 1) : daysFromCivil(y, m + 1, 1);
  return next - daysFromCivil(y, m, 1);
}

/** `date` plus `days`, calendar arithmetic only (no time zones involved). */
export function addTaskDays(date: string, days: number): TaskLocalDate {
  const { y, m, d } = parseLocalDate(date);
  const next = civilFromDays(daysFromCivil(y, m, d) + days);
  return formatCivil(next.y, next.m, next.d);
}

/** A real `YYYY-MM-DD` calendar day: 2026-02-30 and 2026-13-01 are refused. */
export function isTaskLocalDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && addTaskDays(date, 0) === date;
}

/** 0-6, Sunday first. */
export function taskWeekday(date: string): number {
  const { y, m, d } = parseLocalDate(date);
  // 1970-01-01 was a Thursday.
  return (((daysFromCivil(y, m, d) + 4) % 7) + 7) % 7;
}

/** Whole days from `from` to `to`. */
export function taskDaysBetween(from: string, to: string): number {
  const a = parseLocalDate(from);
  const b = parseLocalDate(to);
  return daysFromCivil(b.y, b.m, b.d) - daysFromCivil(a.y, a.m, a.d);
}

/**
 * The first occurrence strictly after `date`. Monthly dates past a short
 * month's end land on its last day.
 */
export function nextTaskOccurrence(date: string, recurrence: TaskRecurrence): TaskLocalDate {
  const interval = Math.max(1, recurrence.interval);
  switch (recurrence.frequency) {
    case "daily":
      return addTaskDays(date, interval);
    case "weekly": {
      const days = [...new Set(recurrence.daysOfWeek ?? [])].sort((a, b) => a - b);
      if (days.length === 0) return addTaskDays(date, 7 * interval);
      const weekday = taskWeekday(date);
      const later = days.find((day) => day > weekday);
      if (later !== undefined) return addTaskDays(date, later - weekday);
      // Wrap to the first chosen day of the week `interval` weeks on.
      return addTaskDays(date, 7 * interval - weekday + days[0]!);
    }
    case "monthly": {
      const { y, m, d } = parseLocalDate(date);
      const target = recurrence.dayOfMonth ?? d;
      const first = parseLocalDate(civil(y, m + interval, 1));
      return formatCivil(first.y, first.m, Math.min(target, daysInMonth(first.y, first.m)));
    }
  }
}

/**
 * A repeat rule as stored: `occurrence` kept only while the series ends
 * after a count, set to `occurrence` (what the series has reached), and
 * never from the caller.
 */
export function withTaskOccurrence(recurrence: TaskRecurrence, occurrence: number): TaskRecurrence {
  const { occurrence: _ignored, ...rule } = recurrence;
  return rule.endAfterCount === undefined
    ? rule
    : { ...rule, occurrence: Math.max(1, Math.floor(occurrence)) };
}

/**
 * The series' next occurrence after the one on `date`, or null when an end
 * condition stops it. `counted` is false when that occurrence was skipped
 * (deleted): like Lucive, only live occurrences count toward
 * `endAfterCount`, so a skip never ends the series by count.
 */
export function followingTaskOccurrence(
  date: string,
  recurrence: TaskRecurrence,
  counted: boolean = true,
): { readonly date: TaskLocalDate; readonly recurrence: TaskRecurrence } | null {
  const next = nextTaskOccurrence(date, recurrence);
  if (recurrence.endAfterDate !== undefined && next > recurrence.endAfterDate) return null;
  const reached = recurrence.occurrence ?? 1;
  if (counted && recurrence.endAfterCount !== undefined && reached >= recurrence.endAfterCount) {
    return null;
  }
  return {
    date: next,
    recurrence: withTaskOccurrence(recurrence, counted ? reached + 1 : reached),
  };
}

let taskWeekStartsOn = 1;

/**
 * The weekday weeks start on (0-6, Sunday first), Monday until the synced
 * account says otherwise. Clients and the server set it from Task Sync status
 * so this machine's weeks match the account's other devices.
 */
export function setTaskWeekStartsOn(day: number): void {
  if (Number.isInteger(day) && day >= 0 && day <= 6) taskWeekStartsOn = day;
}

export function getTaskWeekStartsOn(): number {
  return taskWeekStartsOn;
}

/** The week (from the week start day), month or year containing `date`. */
export function taskPeriodFor(
  horizon: TaskHorizon,
  date: string,
  weekStartsOn: number = taskWeekStartsOn,
): { readonly startsOn: TaskLocalDate; readonly endsOn: TaskLocalDate } {
  const { y, m } = parseLocalDate(date);
  switch (horizon) {
    case "week": {
      const sinceStart = (taskWeekday(date) - weekStartsOn + 7) % 7;
      const startsOn = addTaskDays(date, -sinceStart);
      return { startsOn, endsOn: addTaskDays(startsOn, 6) };
    }
    case "month":
      return { startsOn: formatCivil(y, m, 1), endsOn: formatCivil(y, m, daysInMonth(y, m)) };
    case "year":
      return { startsOn: formatCivil(y, 1, 1), endsOn: formatCivil(y, 12, 31) };
  }
}

/** A local calendar day from its parts, for callers that read their own clock. */
export function taskLocalDateOf(year: number, month: number, day: number): TaskLocalDate {
  return formatCivil(year, month, day);
}

/** The local calendar day at `nowMs` in the caller's time zone. */
export function localTaskDate(nowMs: number): TaskLocalDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(nowMs);
}

/** A handoff message also carries these tasks, sent once for a batch. */
export const TaskHandoffDelivery = Schema.Struct({
  taskIds: Schema.Array(TaskId).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type TaskHandoffDelivery = typeof TaskHandoffDelivery.Type;

/** Names a handoff message shows for a task's links, when known. */
export interface TaskHandoffNames {
  readonly project?: (projectId: string) => string | undefined;
  readonly thread?: (threadId: string) => string | undefined;
  readonly workstream?: (projectId: string, statusId: string) => string | undefined;
}

/** Where a task lives, in words, for a handoff message. */
export function describeTaskHome(home: TaskHome): string {
  switch (home.kind) {
    case "date":
      return home.reminderTime !== undefined
        ? `${home.date}, reminder ${home.reminderTime}`
        : home.date;
    case "period":
      return `the ${home.horizon} ${home.startsOn} to ${home.endsOn}`;
    case "backlog":
      return home.horizon === null ? "the general backlog" : `the ${home.horizon} backlog`;
  }
}

/**
 * The message a task handoff sends to the receiving thread: every task's id,
 * title, notes, home and links, so the receiver can route it with the task
 * tools.
 */
export function taskHandoffMessage(
  tasks: ReadonlyArray<Pick<Task, "id" | "title" | "notes" | "home" | "links" | "recurrence">>,
  names: TaskHandoffNames = {},
): string {
  const one = tasks.length === 1;
  const lines = [
    one
      ? "Task handoff: the user handed you this task from Tasks."
      : `Task handoff: the user handed you these ${tasks.length} tasks from Tasks.`,
    "Route each one: do it, hand it to the right agent or coordinator, or tell the user what it needs. Use the task id with the cp_task_* tools (complete it with cp_task_update when it is done).",
  ];
  for (const task of tasks) {
    lines.push("", `- ${task.title} (task ${task.id})`);
    lines.push(`  Home: ${describeTaskHome(task.home)}${task.recurrence ? ", repeating" : ""}`);
    const links = task.links;
    if (links !== undefined) {
      const parts: string[] = [];
      if (links.projectId !== undefined) {
        const title = names.project?.(links.projectId);
        parts.push(`Project ${title ?? links.projectId} (${links.projectId})`);
      }
      if (links.threadId !== undefined) {
        const title = names.thread?.(links.threadId);
        parts.push(`thread ${title ?? links.threadId} (${links.threadId})`);
      }
      if (links.statusId !== undefined && links.projectId !== undefined) {
        const title = names.workstream?.(links.projectId, links.statusId);
        parts.push(`workstream ${title ?? links.statusId} (${links.statusId})`);
      }
      if (parts.length > 0) lines.push(`  Links: ${parts.join("; ")}`);
    }
    if (task.notes !== undefined) {
      lines.push(`  Notes: ${task.notes.replace(/\n+/g, " / ")}`);
    }
  }
  return lines.join("\n");
}

/**
 * Command id of a handoff that delivers, and the id of the message it sends:
 * a held send (`cp-send:`), started once the receiving thread is idle. The
 * delivery ledger needs the two ids equal.
 */
export function taskHandoffDeliveryId(threadId: string, uuid: string): string {
  return `cp-send:${threadId}:task-handoff:${uuid}`;
}

export function isTaskHandoffDeliveryId(id: string, threadId: string): boolean {
  return id.startsWith(`cp-send:${threadId}:task-handoff:`);
}
