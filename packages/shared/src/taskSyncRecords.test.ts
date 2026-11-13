import { describe, expect, it } from "vite-plus/test";

import {
  controlPlaneIntentsFromLucive,
  controlPlaneTasksFromLucive,
  lucivePlacementOf,
  type LuciveWireTask,
} from "./taskSyncRecords.ts";

const AT = "2026-11-13T12:00:00.000Z";
const wire = (id: string, extra: Partial<LuciveWireTask> = {}): LuciveWireTask => ({
  id,
  title: id,
  notes: null,
  status: "todo",
  scheduledDate: null,
  reminderTime: null,
  backlogHorizon: null,
  completedAt: null,
  sortOrder: 0,
  isTemplate: false,
  templateId: null,
  recurrence: null,
  createdAt: AT,
  updatedAt: AT,
  deletedAt: null,
  ...extra,
});

describe("Lucive mapping", () => {
  const state = {
    tasks: [
      wire("day", { scheduledDate: "2026-11-13", reminderTime: "09:30", sortOrder: 2 }),
      wire("committed", { sortOrder: 1 }),
      wire("month-backlog", { backlogHorizon: "month", sortOrder: 3 }),
      wire("template", {
        isTemplate: true,
        recurrence: { frequency: "weekly", interval: 1, anchor: "calendar" },
      }),
      wire("instance", { templateId: "template", scheduledDate: "2026-11-16", sortOrder: 4 }),
      wire("gone", { deletedAt: AT }),
    ],
    periods: [
      {
        id: "w46",
        horizon: "week" as const,
        startsOn: "2026-11-09",
        endsOn: "2026-11-15",
        focus: "Ship payments.",
        state: "open" as const,
        updatedAt: AT,
        deletedAt: null,
      },
    ],
    memberships: [
      {
        id: "m1",
        periodId: "w46",
        taskId: "committed",
        role: "commitment" as const,
        sortOrder: 0,
        deletedAt: null,
      },
    ],
  };

  it("gives each live task one home and its series' rule, in Lucive's order", () => {
    const tasks = controlPlaneTasksFromLucive(state, "2026-11-13");
    expect(tasks.map((t) => t.id)).toEqual(["committed", "day", "month-backlog", "instance"]);
    expect(tasks[0]!.home).toEqual({
      kind: "period",
      horizon: "week",
      startsOn: "2026-11-09",
      endsOn: "2026-11-15",
    });
    expect(tasks[1]!.home).toEqual({ kind: "date", date: "2026-11-13", reminderTime: "09:30" });
    expect(tasks[2]!.home).toEqual({ kind: "backlog", horizon: "month" });
    expect(tasks[3]!.recurrence).toEqual({ frequency: "weekly", interval: 1 });
    expect(tasks[3]!.seriesId).toBe("template");
    expect(tasks[0]!.orderKey! < tasks[1]!.orderKey!).toBe(true);
    expect(tasks[1]!.importSource).toEqual({ kind: "lucive", id: "day" });
  });

  it("reads period focus lines as intents and writes homes back as placements", () => {
    expect(controlPlaneIntentsFromLucive(state)).toEqual([
      { horizon: "week", startsOn: "2026-11-09", text: "Ship payments.", updatedAt: AT },
    ]);
    expect(lucivePlacementOf({ kind: "date", date: "2026-11-14", reminderTime: "09:00" })).toEqual({
      scheduledDate: "2026-11-14",
      reminderTime: "09:00",
      backlogHorizon: null,
      commitment: null,
    });
    expect(
      lucivePlacementOf({
        kind: "period",
        horizon: "month",
        startsOn: "2026-11-01",
        endsOn: "2026-11-30",
      }).commitment,
    ).toEqual({ horizon: "month", startsOn: "2026-11-01" });
  });
});
