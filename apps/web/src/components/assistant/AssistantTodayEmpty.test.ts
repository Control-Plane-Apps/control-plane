import { describe, expect, it } from "vite-plus/test";

import { formatBriefTime, greetingFor } from "./AssistantTodayEmpty";

describe("greetingFor", () => {
  it("follows the time of day", () => {
    expect(greetingFor(new Date(2026, 10, 13, 7, 0))).toBe("Good morning");
    expect(greetingFor(new Date(2026, 10, 13, 12, 0))).toBe("Good afternoon");
    expect(greetingFor(new Date(2026, 10, 13, 18, 30))).toBe("Good evening");
  });
});

describe("formatBriefTime", () => {
  it("reads the 24-hour setting as a clock time", () => {
    const formatted = formatBriefTime("07:00");
    expect(formatted).toContain("7");
    expect(formatted).toContain("00");
  });
});
