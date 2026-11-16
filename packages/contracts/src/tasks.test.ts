import { describe, expect, it } from "vite-plus/test";

import {
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
