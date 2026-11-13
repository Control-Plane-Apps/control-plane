import { describe, expect, it } from "vite-plus/test";

import { addTaskDays, nextTaskOccurrence, taskPeriodFor, taskWeekday } from "./tasks.ts";

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
