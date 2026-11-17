import { describe, expect, it } from "vite-plus/test";

import {
  describeTaskHome,
  isTaskHandoffDeliveryId,
  taskHandoffDeliveryId,
  taskHandoffMessage,
  addTaskDays,
  followingTaskOccurrence,
  nextTaskOccurrence,
  taskPeriodFor,
  taskWeekday,
  withTaskOccurrence,
} from "./tasks.ts";

describe("task dates", () => {
  it("does calendar arithmetic across month and year ends", () => {
    expect(addTaskDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addTaskDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(taskWeekday("2026-11-13")).toBe(5);
  });

  it("starts weeks on the day given, Monday by default", () => {
    // 2026-11-16 is a Monday, 2026-11-15 the Sunday before it.
    expect(taskPeriodFor("week", "2026-11-16", 1).startsOn).toBe("2026-11-16");
    expect(taskPeriodFor("week", "2026-11-16", 0)).toEqual({
      startsOn: "2026-11-15",
      endsOn: "2026-11-21",
    });
    expect(taskPeriodFor("week", "2026-11-15", 0).startsOn).toBe("2026-11-15");
    expect(taskPeriodFor("week", "2026-11-15", 1).startsOn).toBe("2026-11-09");
    expect(taskPeriodFor("week", "2026-11-18")).toEqual(taskPeriodFor("week", "2026-11-18", 1));
  });

  it("finds Monday-to-Sunday weeks, months and years", () => {
    expect(taskPeriodFor("week", "2026-11-13")).toEqual({
      startsOn: "2026-11-09",
      endsOn: "2026-11-15",
    });
    expect(taskPeriodFor("week", "2026-11-15")).toEqual({
      startsOn: "2026-11-09",
      endsOn: "2026-11-15",
    });
    expect(taskPeriodFor("month", "2026-02-10")).toEqual({
      startsOn: "2026-02-01",
      endsOn: "2026-02-28",
    });
    expect(taskPeriodFor("year", "2026-11-13")).toEqual({
      startsOn: "2026-01-01",
      endsOn: "2026-12-31",
    });
  });

  it("computes the next occurrence", () => {
    expect(nextTaskOccurrence("2026-11-13", { frequency: "daily", interval: 2 })).toBe(
      "2026-11-15",
    );
    expect(nextTaskOccurrence("2026-11-16", { frequency: "weekly", interval: 1 })).toBe(
      "2026-11-23",
    );
    // Monday and Thursday: Monday -> Thursday -> next Monday.
    const twice = { frequency: "weekly", interval: 1, daysOfWeek: [1, 4] } as const;
    expect(nextTaskOccurrence("2026-11-16", twice)).toBe("2026-11-19");
    expect(nextTaskOccurrence("2026-11-19", twice)).toBe("2026-11-23");
    expect(nextTaskOccurrence("2026-01-31", { frequency: "monthly", interval: 1 })).toBe(
      "2026-02-28",
    );
    expect(
      nextTaskOccurrence("2026-11-13", { frequency: "monthly", interval: 1, dayOfMonth: 10 }),
    ).toBe("2026-12-10");
  });
});

describe("repeat end conditions", () => {
  const weekly = { frequency: "weekly", interval: 1 } as const;

  it("counts occurrences only while the series ends after a count", () => {
    expect(withTaskOccurrence(weekly, 3)).toEqual(weekly);
    expect(withTaskOccurrence({ ...weekly, endAfterCount: 3, occurrence: 9 }, 2)).toEqual({
      ...weekly,
      endAfterCount: 3,
      occurrence: 2,
    });
  });

  it("stops after N occurrences, like Lucive's live-instance count", () => {
    const rule = withTaskOccurrence({ ...weekly, endAfterCount: 2 }, 1);
    const second = followingTaskOccurrence("2026-11-13", rule);
    expect(second).toEqual({ date: "2026-11-20", recurrence: { ...rule, occurrence: 2 } });
    expect(followingTaskOccurrence("2026-11-20", second!.recurrence)).toBeNull();
    // A skipped occurrence does not count, so the series goes on.
    expect(followingTaskOccurrence("2026-11-20", second!.recurrence, false)).toEqual({
      date: "2026-11-27",
      recurrence: second!.recurrence,
    });
  });

  it("opens nothing after the end date", () => {
    const rule = { ...weekly, endAfterDate: "2026-11-20" };
    expect(followingTaskOccurrence("2026-11-13", rule)?.date).toBe("2026-11-20");
    expect(followingTaskOccurrence("2026-11-20", rule)).toBeNull();
    expect(
      followingTaskOccurrence("2026-11-14", { ...weekly, endAfterDate: "2026-11-20" }),
    ).toBeNull();
  });
});

describe("task handoff messages", () => {
  it("names each task's id, title, home, links and notes", () => {
    const text = taskHandoffMessage(
      [
        {
          id: "t1" as never,
          title: "Book flights",
          notes: "Window seat\nAisle is fine",
          home: { kind: "date", date: "2026-11-20", reminderTime: "09:00" },
          links: { projectId: "acme" as never, threadId: "th" as never, statusId: "ws" as never },
        },
        { id: "t2" as never, title: "Pick hotel", home: { kind: "backlog", horizon: "month" } },
      ],
      {
        project: (id) => (id === "acme" ? "Acme" : undefined),
        thread: () => "Travel",
        workstream: () => "Offsite",
      },
    );
    expect(text).toContain("these 2 tasks");
    expect(text).toContain("- Book flights (task t1)");
    expect(text).toContain("Home: 2026-11-20, reminder 09:00");
    expect(text).toContain(
      "Links: Project Acme (acme); thread Travel (th); workstream Offsite (ws)",
    );
    expect(text).toContain("Notes: Window seat / Aisle is fine");
    expect(text).toContain("- Pick hotel (task t2)");
    expect(text).toContain("Home: the month backlog");
  });

  it("describes every kind of home", () => {
    expect(describeTaskHome({ kind: "date", date: "2026-11-20" })).toBe("2026-11-20");
    expect(
      describeTaskHome({
        kind: "period",
        horizon: "week",
        startsOn: "2026-11-16",
        endsOn: "2026-11-22",
      }),
    ).toBe("the week 2026-11-16 to 2026-11-22");
    expect(describeTaskHome({ kind: "backlog", horizon: null })).toBe("the general backlog");
  });

  it("builds delivery ids in the held-send namespace for one thread", () => {
    const id = taskHandoffDeliveryId("assistant", "u1");
    expect(id).toBe("cp-send:assistant:task-handoff:u1");
    expect(isTaskHandoffDeliveryId(id, "assistant")).toBe(true);
    expect(isTaskHandoffDeliveryId(id, "other")).toBe(false);
  });
});
