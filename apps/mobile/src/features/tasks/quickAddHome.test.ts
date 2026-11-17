import { describe, expect, it } from "vite-plus/test";

import { defaultQuickAddHome } from "./quickAddHome";

describe("defaultQuickAddHome", () => {
  const today = "2026-11-16";

  it("lands on the day card it was opened from", () => {
    expect(defaultQuickAddHome("today", today, undefined, "2026-11-19")).toEqual({
      kind: "date",
      date: "2026-11-19",
    });
  });

  it("ignores a malformed day and falls back to the range", () => {
    expect(defaultQuickAddHome("today", today, undefined, "Thursday")).toEqual({
      kind: "date",
      date: today,
    });
  });

  it("keeps the range defaults without a day", () => {
    expect(defaultQuickAddHome("backlog", today, "week")).toEqual({
      kind: "backlog",
      horizon: "week",
    });
    expect(defaultQuickAddHome(undefined, today)).toEqual({ kind: "date", date: today });
  });
});
