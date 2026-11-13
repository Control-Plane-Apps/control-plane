import { describe, expect, it } from "vite-plus/test";

import { taskHomeOf } from "./taskHandlers.ts";

describe("taskHomeOf", () => {
  it("maps a proposal's when to a task home from the local today", () => {
    expect(taskHomeOf("today", "2026-11-13")).toEqual({ kind: "date", date: "2026-11-13" });
    expect(taskHomeOf("tomorrow", "2026-11-13")).toEqual({ kind: "date", date: "2026-11-14" });
    expect(taskHomeOf(undefined, "2026-11-13")).toEqual({
      kind: "period",
      horizon: "week",
      startsOn: "2026-11-09",
      endsOn: "2026-11-15",
    });
    expect(taskHomeOf("this-month", "2026-11-13")).toEqual({
      kind: "period",
      horizon: "month",
      startsOn: "2026-11-01",
      endsOn: "2026-11-30",
    });
    expect(taskHomeOf("backlog", "2026-11-13")).toEqual({ kind: "backlog", horizon: null });
  });
});
