import { describe, expect, it } from "vite-plus/test";

import {
  moveSections,
  nextWeekDate,
  repeatMenuActions,
  repeatMenuChoice,
  weekendDate,
} from "./taskMenus";

// 2026-11-13 is a Friday.
const FRIDAY = "2026-11-13";

describe("Move sheet targets", () => {
  it("lands this weekend on Saturday, or today once it is the weekend", () => {
    expect(weekendDate(FRIDAY)).toBe("2026-11-14");
    expect(weekendDate("2026-11-14")).toBe("2026-11-14");
    expect(weekendDate("2026-11-15")).toBe("2026-11-15");
  });

  it("lands next week on the coming Monday", () => {
    expect(nextWeekDate(FRIDAY)).toBe("2026-11-16");
    expect(nextWeekDate("2026-11-16")).toBe("2026-11-23");
  });

  it("offers the design's days, commitments and backlogs in order", () => {
    const sections = moveSections(FRIDAY);
    expect(sections.map((section) => section.title)).toEqual([null, "Commit", "Backlog"]);
    expect(sections[0]!.entries.map((entry) => [entry.label, entry.hint ?? null])).toEqual([
      ["Today", null],
      ["Tomorrow", "Sat"],
      ["This weekend", null],
      ["Next week", "Mon"],
    ]);
    expect(sections[2]!.entries.map((entry) => entry.label)).toEqual([
      "General backlog",
      "Week backlog",
      "Month backlog",
      "Year backlog",
    ]);
  });
});

describe("Repeat menu", () => {
  it("offers ends only once the task repeats, and keeps them across cadences", () => {
    expect(repeatMenuActions(null, FRIDAY).map((a) => a.id)).not.toContain("Never ends");
    const weekly = repeatMenuChoice(null, "Weekly", FRIDAY)!;
    const actions = repeatMenuActions(weekly, FRIDAY);
    expect(actions.find((a) => a.id === "Never ends")?.state).toBe("on");
    const five = repeatMenuChoice(weekly, "Ends after 5 times", FRIDAY)!;
    expect(five).toEqual({ frequency: "weekly", interval: 1, endAfterCount: 5 });
    expect(repeatMenuChoice(five, "Daily", FRIDAY)).toEqual({
      frequency: "daily",
      interval: 1,
      endAfterCount: 5,
    });
    expect(repeatMenuChoice(five, "Ends this month", FRIDAY)).toEqual({
      frequency: "weekly",
      interval: 1,
      endAfterDate: "2026-11-30",
    });
    expect(repeatMenuChoice(five, "Does not repeat", FRIDAY)).toBeNull();
  });
});
