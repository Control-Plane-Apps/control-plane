/**
 * Mapping between Lucive Cloud planning records and Control Plane tasks.
 * Fork-owned and pure, so the same rules serve the Mac server and the
 * phone. Transport-agnostic: the records here are the shapes Lucive Cloud's
 * planning sync exchanges (cloud/lib/planningStore.ts WireTask, WirePeriod,
 * WireMembership), copied rather than imported so Control Plane never
 * depends on the Lucive repo.
 *
 * Lucive keeps one placement per task: a day (scheduledDate, optional
 * reminderTime), a commitment to a dated week / month / year period (a
 * `commitment` membership), or a backlog (backlogHorizon, null = general).
 * Recurring series are a template plus generated instances that point at it
 * with templateId; templates are not shown as tasks.
 */
import type {
  Task,
  TaskHome,
  TaskHorizon,
  TaskIntent,
  TaskRecurrence,
  TaskStatus,
} from "@t3tools/contracts";

export interface LuciveWireTask {
  readonly id: string;
  readonly title: string;
  readonly notes: string | null;
  readonly status: string;
  readonly scheduledDate: string | null;
  readonly reminderTime?: string | null;
  readonly backlogHorizon?: TaskHorizon | null;
  readonly completedAt: string | null;
  readonly sortOrder: number;
  readonly isTemplate: boolean;
  readonly templateId: string | null;
  readonly recurrence: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface LuciveWirePeriod {
  readonly id: string;
  readonly horizon: "day" | TaskHorizon;
  readonly anchorDate?: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly focus: string | null;
  readonly state: "open" | "closed";
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface LuciveWireMembership {
  readonly id: string;
  readonly periodId: string;
  readonly taskId: string;
  readonly role: "focus" | "commitment" | "reference";
  readonly sortOrder: number;
  readonly deletedAt: string | null;
}

export interface LucivePlanningState {
  readonly tasks: ReadonlyArray<LuciveWireTask>;
  readonly periods: ReadonlyArray<LuciveWirePeriod>;
  readonly memberships: ReadonlyArray<LuciveWireMembership>;
}

const STATUSES = new Set<TaskStatus>(["todo", "completed", "cancelled"]);

const ORDER_DIGITS = "bcdefghijklmnopqrstuvwxyz"; // base 25, never "a", so keys stay valid
const ORDER_WIDTH = 12;
const ORDER_OFFSET = 1e9;
const ORDER_SCALE = 1e4;

/**
 * A stable order key for a synced sort order: fixed-width base-25 over b-z,
 * so string order equals numeric order and an unchanged sortOrder always
 * maps to the same key (a poll never reorders anything by itself).
 */
export function orderKeyForSortOrder(sortOrder: number): string {
  const clamped = Math.min(Math.max(sortOrder, -ORDER_OFFSET + 1), ORDER_OFFSET - 1);
  let value = Math.round((clamped + ORDER_OFFSET) * ORDER_SCALE);
  let key = "";
  for (let i = 0; i < ORDER_WIDTH; i += 1) {
    key = ORDER_DIGITS[value % 25]! + key;
    value = Math.floor(value / 25);
  }
  return key;
}

function recurrenceOf(value: unknown): TaskRecurrence | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const frequency = v.frequency;
  if (frequency !== "daily" && frequency !== "weekly" && frequency !== "monthly") return undefined;
  const interval = typeof v.interval === "number" && v.interval >= 1 ? Math.floor(v.interval) : 1;
  const days = Array.isArray(v.daysOfWeek)
    ? v.daysOfWeek.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6)
    : undefined;
  const dayOfMonth =
    typeof v.dayOfMonth === "number" && v.dayOfMonth >= 1 && v.dayOfMonth <= 31
      ? v.dayOfMonth
      : undefined;
  return {
    frequency,
    interval,
    ...(days !== undefined && days.length > 0 ? { daysOfWeek: days } : {}),
    ...(dayOfMonth !== undefined ? { dayOfMonth } : {}),
  };
}

/**
 * The live commitment that places a task, preferring the period containing
 * `today`, then the latest-ending one, like Lucive's own homeOf.
 */
function commitmentHome(
  taskId: string,
  state: LucivePlanningState,
  periodsById: ReadonlyMap<string, LuciveWirePeriod>,
  today: string,
): TaskHome | null {
  const candidates = state.memberships
    .filter((m) => m.taskId === taskId && m.role === "commitment" && m.deletedAt === null)
    .map((m) => periodsById.get(m.periodId))
    .filter(
      (p): p is LuciveWirePeriod & { horizon: TaskHorizon } =>
        p !== undefined && p.deletedAt === null && p.horizon !== "day",
    )
    .sort((a, b) => {
      const aCurrent = a.startsOn <= today && a.endsOn >= today ? 1 : 0;
      const bCurrent = b.startsOn <= today && b.endsOn >= today ? 1 : 0;
      return bCurrent - aCurrent || b.endsOn.localeCompare(a.endsOn);
    });
  const period = candidates[0];
  return period === undefined
    ? null
    : { kind: "period", horizon: period.horizon, startsOn: period.startsOn, endsOn: period.endsOn };
}

/**
 * Lucive's records as Control Plane tasks: live, non-template tasks, each
 * with its one home and its series' repeat rule, ordered as in Lucive.
 */
export function controlPlaneTasksFromLucive(state: LucivePlanningState, today: string): Task[] {
  const periodsById = new Map(state.periods.map((p) => [p.id, p]));
  const templates = new Map(
    state.tasks.filter((t) => t.isTemplate && t.deletedAt === null).map((t) => [t.id, t]),
  );
  const live = state.tasks
    .filter((t) => !t.isTemplate && t.deletedAt === null)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
  return live.map((t): Task => {
    const home: TaskHome =
      commitmentHome(t.id, state, periodsById, today) ??
      (t.scheduledDate !== null
        ? {
            kind: "date",
            date: t.scheduledDate,
            ...(t.reminderTime != null ? { reminderTime: t.reminderTime } : {}),
          }
        : { kind: "backlog", horizon: t.backlogHorizon ?? null });
    const recurrence = recurrenceOf(
      t.templateId !== null ? templates.get(t.templateId)?.recurrence : t.recurrence,
    );
    const status = STATUSES.has(t.status as TaskStatus) ? (t.status as TaskStatus) : "todo";
    const notes = t.notes?.trim();
    return {
      id: t.id as Task["id"],
      title: t.title.trim().length > 0 ? t.title : "Untitled task",
      ...(notes !== undefined && notes.length > 0 ? { notes } : {}),
      status,
      home,
      ...(recurrence !== undefined && home.kind === "date" ? { recurrence } : {}),
      orderKey: orderKeyForSortOrder(t.sortOrder) as Task["orderKey"],
      ...(status !== "todo" && t.completedAt !== null ? { completedAt: t.completedAt } : {}),
      importSource: { kind: "lucive", id: t.id },
      ...(t.templateId !== null ? { seriesId: t.templateId } : {}),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  });
}

/** Each live week / month / year period's focus line as an intent. */
export function controlPlaneIntentsFromLucive(state: LucivePlanningState): TaskIntent[] {
  return state.periods
    .filter(
      (p): p is LuciveWirePeriod & { horizon: TaskHorizon } =>
        p.deletedAt === null && p.horizon !== "day" && (p.focus ?? "").trim().length > 0,
    )
    .map((p) => ({
      horizon: p.horizon,
      startsOn: p.startsOn,
      text: p.focus!.trim(),
      updatedAt: p.updatedAt,
    }));
}

/**
 * The placement fields a Control Plane home writes on a Lucive task. A
 * commitment also needs a `commitment` membership on that period, which the
 * caller adds; the task itself then carries no day or backlog.
 */
export function lucivePlacementOf(home: TaskHome): {
  readonly scheduledDate: string | null;
  readonly reminderTime: string | null;
  readonly backlogHorizon: TaskHorizon | null;
  readonly commitment: { readonly horizon: TaskHorizon; readonly startsOn: string } | null;
} {
  switch (home.kind) {
    case "date":
      return {
        scheduledDate: home.date,
        reminderTime: home.reminderTime ?? null,
        backlogHorizon: null,
        commitment: null,
      };
    case "period":
      return {
        scheduledDate: null,
        reminderTime: null,
        backlogHorizon: null,
        commitment: { horizon: home.horizon, startsOn: home.startsOn },
      };
    case "backlog":
      return {
        scheduledDate: null,
        reminderTime: null,
        backlogHorizon: home.horizon,
        commitment: null,
      };
  }
}
