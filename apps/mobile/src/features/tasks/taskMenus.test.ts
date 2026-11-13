import { describe, expect, it } from "vite-plus/test";

import { moveSections, nextWeekDate, weekendDate } from "./taskMenus";

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
