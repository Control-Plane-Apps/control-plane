import type { TaskSyncStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { taskSyncIndicator } from "./TaskSyncIndicator";
import { defaultHomeForView, dropLabelForView, dropTargetForView } from "./tasksRange";

const TODAY = "2026-11-13";

describe("tasks range helpers", () => {
  it("gives quick add the home of the range you are on", () => {
    expect(defaultHomeForView("today", {}, TODAY)).toEqual({ kind: "date", date: TODAY });
    expect(defaultHomeForView(null, {}, TODAY)).toEqual({ kind: "date", date: TODAY });
    expect(defaultHomeForView("upcoming", {}, TODAY)).toEqual({ kind: "date", date: TODAY });
    expect(defaultHomeForView("week", {}, TODAY)).toEqual({
      kind: "period",
      horizon: "week",
      startsOn: "2026-11-09",
      endsOn: "2026-11-15",
    });
    expect(defaultHomeForView("month", { at: "2026-12-04" }, TODAY)).toMatchObject({
      kind: "period",
      horizon: "month",
      startsOn: "2026-12-01",
    });
    expect(defaultHomeForView("all", {}, TODAY)).toEqual({ kind: "backlog", horizon: null });
    expect(defaultHomeForView("all", { filter: "year" }, TODAY)).toEqual({
      kind: "backlog",
      horizon: "year",
    });
  });

  it("only takes drops on Today and the periods", () => {
    expect(dropTargetForView("today")).toEqual({ kind: "today" });
    expect(dropTargetForView("month")).toEqual({ kind: "commit", horizon: "month" });
    expect(dropTargetForView("upcoming")).toBeNull();
    expect(dropTargetForView("all")).toBeNull();
    expect(dropLabelForView("month", TODAY)).toBe("Move to November");
    expect(dropLabelForView("year", TODAY)).toBe("Move to 2026");
    expect(dropLabelForView("week", TODAY)).toBe("Move to this week");
  });
});

describe("Task Sync indicator", () => {
  const status = (extra: Partial<TaskSyncStatus>) =>
    ({ state: "synced", pendingChanges: 0, ...extra }) as TaskSyncStatus;

  it("reads each sync state as a header chip and a margin line", () => {
    expect(taskSyncIndicator(null).header).toBe("On this Mac");
    expect(taskSyncIndicator(status({ state: "coming-soon" }))).toMatchObject({
      header: "On this Mac",
      margin: "Task Sync",
      action: "Coming soon",
    });
    expect(taskSyncIndicator(status({ state: "signed-out" })).action).toBe("Turn on · $5/month");
    expect(taskSyncIndicator(status({ state: "syncing" })).header).toBe("Syncing");
    expect(taskSyncIndicator(status({ state: "synced" })).margin).toBe("Synced with Lucive");
    expect(taskSyncIndicator(status({ state: "error", pendingChanges: 3 }))).toMatchObject({
      tone: "offline",
      header: "Offline · 3 waiting",
      margin: "3 changes waiting",
    });
  });
});
