import {
  setTaskWeekStartsOn,
  type ProjectStatus,
  type Task,
  type TaskIntent,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

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
  proposedTasksForThread,
  taskAgentState,
  taskIntentFor,
  applyTaskHomeOverrides,
  dayDropHome,
  overridesAfterWrite,
  sameTaskHome,
  settleTaskHomeOverrides,
  type TaskHomeOverride,
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

describe("the Completed filter", () => {
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

describe("proposedTasksForThread", () => {
  const proposal = (projectId: string, threadId: string) => ({
    status: "todo" as const,
    proposal: { projectId, threadId, proposedAt: AT },
  });
  const tasks = [
    task("from-assistant", proposal("assistant-project", "assistant-thread") as Partial<Task>),
    task("from-coordinator", proposal("hometrace", "coordinator-thread") as Partial<Task>),
    task("from-agent", proposal("hometrace", "agent-thread") as Partial<Task>),
  ];

  it("shows a thread its own proposals, and a coordinator its Project's", () => {
    expect(proposedTasksForThread(tasks, "assistant-thread", null).map((t) => t.id)).toEqual([
      "from-assistant",
    ]);
    expect(proposedTasksForThread(tasks, "agent-thread", null).map((t) => t.id)).toEqual([
      "from-agent",
    ]);
    expect(
      proposedTasksForThread(tasks, "coordinator-thread", "hometrace").map((t) => t.id),
    ).toEqual(["from-coordinator", "from-agent"]);
  });
});

describe("taskIntentFor", () => {
  afterEach(() => setTaskWeekStartsOn(1));
  // The Assistant's intent for the week of Monday 2026-11-16, and a Sunday-keyed twin.
  const mondayWeek: TaskIntent = {
    horizon: "week",
    startsOn: "2026-11-16",
    text: "Get ISN live",
    updatedAt: AT,
  };
  const sundayWeek: TaskIntent = { ...mondayWeek, startsOn: "2026-11-15" };

  it("finds the Monday-start week's intent for any day in that week", () => {
    setTaskWeekStartsOn(1);
    for (const day of ["2026-11-16", "2026-11-19", "2026-11-22"]) {
      expect(taskIntentFor([mondayWeek], "week", day)).toBe(mondayWeek);
    }
    expect(taskIntentFor([sundayWeek], "week", "2026-11-16")).toBeUndefined();
  });

  it("finds the Sunday-start week's intent for any day in that week", () => {
    setTaskWeekStartsOn(0);
    for (const day of ["2026-11-15", "2026-11-16", "2026-11-21"]) {
      expect(taskIntentFor([sundayWeek], "week", day)).toBe(sundayWeek);
    }
    expect(taskIntentFor([mondayWeek], "week", "2026-11-16")).toBeUndefined();
  });

  it("takes the week start from the caller when given, ahead of the shared setting", () => {
    setTaskWeekStartsOn(1);
    expect(taskIntentFor([sundayWeek], "week", "2026-11-16", 0)).toBe(sundayWeek);
    expect(taskIntentFor([mondayWeek], "week", "2026-11-16", 1)).toBe(mondayWeek);
  });
});

describe("dropping a task on a day", () => {
  const gym = task("gym", { home: { kind: "date", date: "2026-11-18" } });

  it("moves to that day, keeping the reminder time", () => {
    const timed = task("timed", {
      home: { kind: "date", date: "2026-11-18", reminderTime: "07:00" },
    });
    expect(dayDropHome(timed, "2026-11-19", TODAY)).toEqual({
      kind: "date",
      date: "2026-11-19",
      reminderTime: "07:00",
    });
    expect(dayDropHome(gym, "2026-11-19", TODAY)).toEqual({ kind: "date", date: "2026-11-19" });
  });

  it("does nothing on its own day or for a task that is not open", () => {
    expect(dayDropHome(gym, "2026-11-18", TODAY)).toBeNull();
    expect(dayDropHome({ ...gym, status: "completed" }, "2026-11-19", TODAY)).toBeNull();
  });

  it("moves a repeating occurrence to the day like any other task", () => {
    const repeating = task("washer", {
      home: { kind: "date", date: "2026-11-19" },
      recurrence: { frequency: "monthly", interval: 1 },
    });
    expect(dayDropHome(repeating, "2026-11-20", TODAY)).toEqual({
      kind: "date",
      date: "2026-11-20",
    });
  });

  it("moves a period or backlog task onto a day", () => {
    const committed = task("c", {
      home: { kind: "period", horizon: "week", startsOn: "2026-11-16", endsOn: "2026-11-22" },
    });
    expect(dayDropHome(committed, "2026-11-17", TODAY)).toEqual({
      kind: "date",
      date: "2026-11-17",
    });
  });
});

describe("optimistic task moves", () => {
  const gym = task("gym", { home: { kind: "date", date: "2026-11-18" } });
  const moved = { kind: "date", date: "2026-11-19" } as const;
  const override = (status: TaskHomeOverride["status"]): TaskHomeOverride => ({
    home: moved,
    baseUpdatedAt: gym.updatedAt,
    status,
  });

  it("shows the move at once, and leaves other tasks alone", () => {
    const other = task("other");
    const shown = applyTaskHomeOverrides([gym, other], new Map([["gym", override("saving")]]));
    expect(shown[0]!.home).toEqual(moved);
    expect(shown[1]).toBe(other);
    expect(applyTaskHomeOverrides([gym], new Map())).toEqual([gym]);
  });

  it("keeps a saved move until the server has the same home, a newer copy, or no task", () => {
    const overrides = new Map([["gym", override("saved")]]);
    expect(settleTaskHomeOverrides(overrides, [gym])).toBe(overrides);
    expect(settleTaskHomeOverrides(overrides, [{ ...gym, home: moved }]).size).toBe(0);
    expect(
      settleTaskHomeOverrides(overrides, [
        {
          ...gym,
          home: { kind: "date", date: "2026-11-20" },
          updatedAt: "2026-11-16T09:00:00.000Z",
        },
      ]).size,
    ).toBe(0);
    expect(settleTaskHomeOverrides(overrides, []).size).toBe(0);
  });

  it("never settles a move whose write is still in flight", () => {
    const overrides = new Map([["gym", override("saving")]]);
    expect(settleTaskHomeOverrides(overrides, [{ ...gym, home: moved }])).toBe(overrides);
  });

  it("rolls back on a failed write and keeps on an accepted one", () => {
    const written = override("saving");
    const overrides = new Map([["gym", written]]);
    expect(overridesAfterWrite(overrides, "gym", written, false).size).toBe(0);
    expect(overridesAfterWrite(overrides, "gym", written, true).get("gym")?.status).toBe("saved");
  });

  it("lets a newer move of the same task win over an older write's result", () => {
    const older = override("saving");
    const newer: TaskHomeOverride = { ...older, home: { kind: "date", date: "2026-11-21" } };
    const overrides = new Map([["gym", newer]]);
    expect(overridesAfterWrite(overrides, "gym", older, false)).toBe(overrides);
  });

  it("compares homes by place", () => {
    expect(
      sameTaskHome({ kind: "date", date: "2026-11-18" }, { kind: "date", date: "2026-11-18" }),
    ).toBe(true);
    expect(
      sameTaskHome({ kind: "date", date: "2026-11-18" }, { kind: "backlog", horizon: null }),
    ).toBe(false);
  });
});
