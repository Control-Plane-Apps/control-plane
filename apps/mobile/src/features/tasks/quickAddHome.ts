import { taskPeriodFor, type TaskHome, type TaskHorizon } from "@t3tools/contracts";

// Fork-owned. Where Quick add puts a task whose title names no day.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The home for a quick add: the day it was opened from (an Upcoming day card)
 * wins, then the range, then today.
 */
export function defaultQuickAddHome(
  horizon: "today" | TaskHorizon | "backlog" | undefined,
  today: string,
  backlog?: TaskHorizon,
  date?: string,
): TaskHome {
  if (date !== undefined && ISO_DATE.test(date)) return { kind: "date", date };
  switch (horizon) {
    case "week":
    case "month":
    case "year":
      return { kind: "period", horizon, ...taskPeriodFor(horizon, today) };
    case "backlog":
      return { kind: "backlog", horizon: backlog ?? null };
    default:
      return { kind: "date", date: today };
  }
}
