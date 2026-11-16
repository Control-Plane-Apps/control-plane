import type { TaskBacklogFilter, TaskMoveTarget } from "@t3tools/client-runtime/state/projects";
import { formatTaskPeriodTitle } from "@t3tools/client-runtime/state/projects";
import { taskPeriodFor, type TaskHome } from "@t3tools/contracts";

export type TasksView = "today" | "week" | "month" | "year" | "upcoming" | "all";

export const TASK_VIEWS: ReadonlyArray<TasksView> = [
  "today",
  "week",
  "month",
  "year",
  "upcoming",
  "all",
];

export const TASK_VIEW_LABEL: Record<TasksView, string> = {
  today: "Today",
  week: "Week",
  month: "Month",
  year: "Year",
  upcoming: "Upcoming",
  all: "All tasks",
};

export interface TasksSearch {
  readonly project?: string | undefined;
  readonly filter?: Exclude<TaskBacklogFilter, "all"> | undefined;
  /** Task ids to scroll to and light up briefly, comma separated. */
  readonly highlight?: string | undefined;
}

/** Where a task dropped on a range tab lands; Upcoming and All tasks take no drops. */
export function dropTargetForView(view: TasksView): TaskMoveTarget | null {
  switch (view) {
    case "today":
      return { kind: "today" };
    case "week":
    case "month":
    case "year":
      return { kind: "commit", horizon: view };
    default:
      return null;
  }
}

/** The tooltip while a task hovers a tab: "Move to today", "Move to November". */
export function dropLabelForView(view: TasksView, today: string): string | null {
  switch (view) {
    case "today":
      return "Move to today";
    case "week":
      return "Move to this week";
    case "month":
      return `Move to ${formatTaskPeriodTitle("month", taskPeriodFor("month", today).startsOn).split(" ")[0]}`;
    case "year":
      return `Move to ${taskPeriodFor("year", today).startsOn.slice(0, 4)}`;
    default:
      return null;
  }
}

/**
 * The home a new task gets from quick add or the inline add row on each
 * range: the day, the browsed period's commitment, or a backlog.
 */
export function defaultHomeForView(
  view: TasksView | null,
  search: TasksSearch,
  today: string,
): TaskHome {
  switch (view) {
    case "week":
    case "month":
    case "year":
      return { kind: "period", horizon: view, ...taskPeriodFor(view, today) };
    case "all": {
      const filter = search.filter;
      return filter === "week" || filter === "month" || filter === "year"
        ? { kind: "backlog", horizon: filter }
        : { kind: "backlog", horizon: null };
    }
    default:
      return { kind: "date", date: today };
  }
}

export function isTasksView(value: unknown): value is TasksView {
  return typeof value === "string" && (TASK_VIEWS as ReadonlyArray<string>).includes(value);
}
