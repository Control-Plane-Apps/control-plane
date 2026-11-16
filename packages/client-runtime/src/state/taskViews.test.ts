import type { ProjectStatus, Task } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatTaskRecurrence,
  taskRecurrenceEnd,
  withTaskRecurrenceCadence,
  withTaskRecurrenceEnd,
  allTasks,
  committedTasks,
  formatTaskHome,
  formatTaskRange,
  homeForMove,
  parseQuickAdd,
  proposedTasks,
  shiftTaskPeriod,
  taskAgentState,
  todayTasks,
  upcomingTasks,
} from "./taskViews.ts";

const TODAY = "2026-11-13";
const AT = "2026-11-13T12:00:00.000Z";

const task = (id: string, extra: Partial<Task> = {}): Task =>
  ({
    id,
    title: id,
    status: "todo",
    home: { kind: "date", date: TODAY },
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  }) as Task;

describe("task views", () => {
  const tasks = [
    task("overdue", { home: { kind: "date", date: "2026-11-12" } }),
    task("today", { orderKey: "m" }),
    task("tomorrow", { home: { kind: "date", date: "2026-11-14" } }),
    task("week", {
      home: { kind: "period", horizon: "week", startsOn: "2026-11-09", endsOn: "2026-11-15" },
    }),
    task("month-backlog", { home: { kind: "backlog", horizon: "month" } }),
    task("proposed", {
      proposal: { projectId: "p", threadId: "c", proposedAt: AT } as never,
    }),
    task("done", { status: "completed", completedAt: AT }),
    task("weekly", { recurrence: { frequency: "weekly", interval: 1 } }),
  ];

  it("splits Today, commitments, upcoming, backlog and proposals", () => {
    expect(todayTasks(tasks, TODAY).map((t) => t.id)).toEqual(["today", "overdue", "weekly"]);
    expect(committedTasks(tasks, "week", TODAY).map((t) => t.id)).toEqual(["week"]);
    expect(upcomingTasks(tasks, TODAY)[0]).toMatchObject({ date: "2026-11-14" });
    expect(upcomingTasks(tasks, TODAY)[0]!.tasks.map((t) => t.id)).toEqual(["tomorrow"]);
    expect(proposedTasks(tasks).map((t) => t.id)).toEqual(["proposed"]);
    const all = allTasks(tasks, "month");
    expect(all.open.map((t) => t.id)).toEqual(["month-backlog"]);
    expect(allTasks(tasks, "all").recurring.map((t) => t.id)).toEqual(["weekly"]);
    expect(allTasks(tasks, "all").completed).toBe(1);
  });

  it("labels homes relative to today", () => {
    expect(formatTaskHome({ kind: "date", date: "2026-11-12" }, TODAY)).toBe("Yesterday");
    expect(formatTaskHome({ kind: "date", date: "2026-11-15" }, TODAY)).toBe("Sun");
    expect(formatTaskHome({ kind: "date", date: "2026-12-10" }, TODAY)).toBe("Dec 10");
    expect(
      formatTaskHome(
        { kind: "period", horizon: "week", startsOn: "2026-11-09", endsOn: "2026-11-15" },
        TODAY,
      ),
    ).toBe("This week");
    expect(formatTaskHome({ kind: "backlog", horizon: null }, TODAY)).toBe("General backlog");
    expect(formatTaskRange("2026-11-09", "2026-11-15")).toBe("Nov 9 to 15");
  });

  it("parses a trailing when-phrase in quick add", () => {
    expect(parseQuickAdd("Ask Dana for Q1 pricing numbers tomorrow 9am", TODAY)).toEqual({
      title: "Ask Dana for Q1 pricing numbers",
      home: { kind: "date", date: "2026-11-14", reminderTime: "09:00" },
      phrase: "tomorrow 9am",
    });
    expect(parseQuickAdd("Inspector outreach, 10 calls this week", TODAY).home).toEqual({
      kind: "period",
      horizon: "week",
      startsOn: "2026-11-09",
      endsOn: "2026-11-15",
    });
    expect(parseQuickAdd("Call county monday", TODAY).home).toEqual({
      kind: "date",
      date: "2026-11-16",
    });
    expect(parseQuickAdd("Reread Shape Up", TODAY).home).toBeNull();
    expect(parseQuickAdd("tomorrow", TODAY).home).toBeNull();
  });

  it("moves keep a day's reminder", () => {
    expect(
      homeForMove(
        { kind: "tomorrow" },
        { kind: "date", date: TODAY, reminderTime: "15:00" },
        TODAY,
      ),
    ).toEqual({ kind: "date", date: "2026-11-14", reminderTime: "15:00" });
    expect(
      homeForMove({ kind: "commit", horizon: "month" }, { kind: "backlog", horizon: null }, TODAY),
    ).toEqual({ kind: "period", horizon: "month", startsOn: "2026-11-01", endsOn: "2026-11-30" });
  });

  it("follows a handed-off task through its workstream", () => {
    const status = (state: ProjectStatus["state"], extra: Partial<ProjectStatus> = {}) =>
      ({
        id: "pay",
        title: "Payments",
        state,
        summary: "s",
        updatedAt: AT,
        ...extra,
      }) as ProjectStatus;
    const handed = task("t", {
      links: { projectId: "p", threadId: "a", statusId: "pay" } as never,
      handoff: { kind: "agent", threadId: "a", at: AT } as never,
    });
    const projects = (s: ProjectStatus) => [{ id: "p", assistant: { statuses: [s] } }];
    const idle = [{ id: "a", session: { status: "ready" } }];
    const running = [{ id: "a", session: { status: "running" } }];
    expect(taskAgentState(handed, idle, projects(status("working"))).kind).toBe("handed-off");
    expect(taskAgentState(handed, running, projects(status("working"))).kind).toBe("agent-working");
    expect(
      taskAgentState(
        handed,
        running,
        projects(
          status("needs-you", { decision: { question: "q", recommendation: "r", openedAt: AT } }),
        ),
      ).kind,
    ).toBe("needs-you");
    expect(taskAgentState(handed, idle, projects(status("done"))).kind).toBe("workstream-done");
    // "Not yet" hides the prompt until the workstream is written again.
    const notYet = { ...handed, completionPromptDismissedAt: "2026-11-13T13:00:00.000Z" };
    expect(taskAgentState(notYet, idle, projects(status("done"))).kind).toBe("handed-off");
    expect(
      taskAgentState(
        notYet,
        idle,
        projects(status("done", { updatedAt: "2026-11-13T14:00:00.000Z" })),
      ).kind,
    ).toBe("workstream-done");
    expect(taskAgentState({ ...handed, status: "completed" }, idle, []).kind).toBe("completed");
  });
});

describe("repeat ends", () => {
  const weekly = { frequency: "weekly", interval: 1 } as const;

  it("reads how a series ends", () => {
    expect(formatTaskRecurrence(weekly)).toBe("Weekly");
    expect(formatTaskRecurrence({ ...weekly, endAfterCount: 5 })).toBe("Weekly, 5 times");
    expect(formatTaskRecurrence({ ...weekly, endAfterCount: 1 })).toBe("Weekly, once");
    expect(formatTaskRecurrence({ ...weekly, endAfterDate: "2026-12-31" })).toBe(
      "Weekly, until Dec 31",
    );
  });

  it("sets one end at a time and keeps it across a new cadence", () => {
    const counted = withTaskRecurrenceEnd(
      { ...weekly, endAfterDate: "2026-12-31", occurrence: 2 },
      { kind: "count", count: 4 },
    );
    expect(counted).toEqual({ ...weekly, endAfterCount: 4 });
    expect(taskRecurrenceEnd(counted)).toEqual({ kind: "count", count: 4 });
    expect(withTaskRecurrenceCadence(counted, { frequency: "daily", interval: 1 })).toEqual({
      frequency: "daily",
      interval: 1,
      endAfterCount: 4,
    });
    expect(withTaskRecurrenceCadence(counted, null)).toBeNull();
    expect(withTaskRecurrenceEnd(counted, { kind: "never" })).toEqual(weekly);
  });
});

describe("range navigation and the Completed filter", () => {
  it("steps to the previous and next week, month and year", () => {
    // Weeks start on Monday by default: Nov 13 2026 sits in the week of Nov 9.
    expect(shiftTaskPeriod("week", TODAY, 1)).toBe("2026-11-16");
    expect(shiftTaskPeriod("week", TODAY, -1)).toBe("2026-11-02");
    expect(shiftTaskPeriod("month", TODAY, 1)).toBe("2026-12-01");
    expect(shiftTaskPeriod("month", "2026-01-31", -1)).toBe("2025-12-01");
    expect(shiftTaskPeriod("year", TODAY, -2)).toBe("2024-01-01");
    expect(shiftTaskPeriod("month", TODAY, 0)).toBe("2026-11-01");
  });

  it("lists completed tasks newest first under the Completed filter", () => {
    const tasks = [
      task("open"),
      task("older", { status: "completed", completedAt: "2026-11-10T09:00:00.000Z" }),
      task("newer", { status: "completed", completedAt: "2026-11-12T09:00:00.000Z" }),
    ];
    const completed = allTasks(tasks, "completed");
    expect(completed.done.map((entry) => entry.id)).toEqual(["newer", "older"]);
    expect(completed.open).toEqual([]);
    expect(completed.completed).toBe(2);
    expect(allTasks(tasks, "all").done).toEqual([]);
    expect(allTasks(tasks, "all").open.map((entry) => entry.id)).toEqual(["open"]);
  });
});
