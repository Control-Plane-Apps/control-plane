import { describe, expect, it } from "vite-plus/test";

import type { WireMembershipFull, WirePeriodFull, WireTaskWithSeq } from "./cloudClient.ts";
import { planCommitmentRollover, type CommitmentRolloverInput } from "./rollover.ts";

const T0 = "2026-11-01T00:00:00.000Z";
const T1 = "2026-11-10T00:00:00.000Z";
// Monday 16 November 2026; weeks start on Monday.
const TODAY = "2026-11-16";

const task = (id: string, extra: Partial<WireTaskWithSeq> = {}): WireTaskWithSeq => ({
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
  createdAt: T0,
  updatedAt: T0,
  deletedAt: null,
  ...extra,
});

const period = (
  id: string,
  horizon: WirePeriodFull["horizon"],
  startsOn: string,
  endsOn: string,
  extra: Partial<WirePeriodFull> = {},
): WirePeriodFull => ({
  id,
  horizon,
  anchorDate: startsOn,
  startsOn,
  endsOn,
  title: null,
  focus: null,
  state: "open",
  revision: 1,
  createdAt: T0,
  updatedAt: T0,
  deletedAt: null,
  ...extra,
});

const commitment = (
  id: string,
  periodId: string,
  taskId: string,
  sortOrder = 0,
  extra: Partial<WireMembershipFull> = {},
): WireMembershipFull => ({
  id,
  periodId,
  taskId,
  role: "commitment",
  sortOrder,
  revision: 1,
  createdAt: T1,
  updatedAt: T1,
  deletedAt: null,
  ...extra,
});

const lastWeek = period("last-week", "week", "2026-11-09", "2026-11-15");
const thisWeek = period("this-week", "week", "2026-11-16", "2026-11-22");
const october = period("october", "month", "2026-10-01", "2026-10-31");

const plan = (input: Partial<CommitmentRolloverInput>, weekStartsOn = 1) =>
  planCommitmentRollover(
    { tasks: [], periods: [], memberships: [], ...input },
    TODAY,
    weekStartsOn,
  );

describe("planCommitmentRollover", () => {
  it("moves an undated todo commitment to the current period, one jump for several missed", () => {
    const longAgo = period("sept", "week", "2026-09-07", "2026-09-13");
    const year = period("2024", "year", "2024-01-01", "2024-12-31");
    const result = plan({
      tasks: [task("w"), task("m"), task("y")],
      periods: [longAgo, october, year],
      memberships: [
        commitment("cw", "sept", "w"),
        commitment("cm", "october", "m"),
        commitment("cy", "2024", "y"),
      ],
    });
    expect(result.retire.map((m) => m.id).sort()).toEqual(["cm", "cw", "cy"]);
    expect(result.create.map((c) => [c.taskId, c.horizon, c.startsOn, c.endsOn])).toEqual(
      expect.arrayContaining([
        ["w", "week", "2026-11-16", "2026-11-22"],
        ["m", "month", "2026-11-01", "2026-11-30"],
        ["y", "year", "2026-01-01", "2026-12-31"],
      ]),
    );
    expect(result.create).toHaveLength(3);
  });

  it("appends after the target's live memberships in source order, per target period", () => {
    const result = plan({
      tasks: [task("a"), task("b"), task("c"), task("held"), task("gone"), task("m1"), task("m2")],
      periods: [lastWeek, thisWeek, october],
      memberships: [
        commitment("cb", "last-week", "b", 2),
        commitment("cc", "last-week", "c", 1),
        commitment("ca", "last-week", "a", 1),
        // Live memberships already on this week: the highest is 4.
        commitment("held-1", "this-week", "held", 4),
        // A retired one does not count.
        commitment("gone-1", "this-week", "gone", 9, { deletedAt: T1 }),
        commitment("cm2", "october", "m2", 7),
        commitment("cm1", "october", "m1", 3),
      ],
    });
    const orders = Object.fromEntries(result.create.map((c) => [c.taskId, c.sortOrder]));
    // Week: source order 1 (a, then c by id), 2 (b), after 4. Month: new period, from 0.
    expect(orders).toEqual({ a: 5, c: 6, b: 7, m1: 0, m2: 1 });
    // Not the task's own sortOrder.
    expect(
      plan({
        tasks: [task("x", { sortOrder: 42 })],
        periods: [lastWeek],
        memberships: [commitment("cx", "last-week", "x", 3)],
      }).create[0]?.sortOrder,
    ).toBe(0);
  });

  it("retires a dated commitment without a replacement", () => {
    const result = plan({
      tasks: [task("d", { scheduledDate: "2026-11-12", reminderTime: "09:00" })],
      periods: [lastWeek],
      memberships: [commitment("cd", "last-week", "d")],
    });
    expect(result.retire.map((m) => m.id)).toEqual(["cd"]);
    expect(result.create).toEqual([]);
  });

  it("retires behind a newer backlog placement, and rolls over an older one", () => {
    const newer = plan({
      tasks: [task("b", { backlogHorizon: "month", updatedAt: "2026-11-12T00:00:00.000Z" })],
      periods: [lastWeek],
      memberships: [commitment("cb", "last-week", "b")],
    });
    expect(newer.retire.map((m) => m.id)).toEqual(["cb"]);
    expect(newer.create).toEqual([]);
    const older = plan({
      tasks: [task("b", { backlogHorizon: "month", updatedAt: T0 })],
      periods: [lastWeek],
      memberships: [commitment("cb", "last-week", "b")],
    });
    expect(older.create.map((c) => c.taskId)).toEqual(["b"]);
  });

  it("retires behind a live commitment on a period that has not ended", () => {
    const november = period("november", "month", "2026-11-01", "2026-11-30");
    const result = plan({
      tasks: [task("t")],
      periods: [lastWeek, november],
      memberships: [commitment("old", "last-week", "t"), commitment("now", "november", "t")],
    });
    expect(result.retire.map((m) => m.id)).toEqual(["old"]);
    expect(result.create).toEqual([]);
  });

  it("rolls the latest-ending of several expired commitments and retires the rest", () => {
    const result = plan({
      tasks: [task("t")],
      periods: [lastWeek, october],
      memberships: [commitment("month", "october", "t"), commitment("week", "last-week", "t")],
    });
    expect(result.retire.map((m) => m.id)).toEqual(["week", "month"]);
    expect(result.create.map((c) => [c.horizon, c.startsOn])).toEqual([["week", "2026-11-16"]]);
  });

  it("skips a closed source period and leaves the source when the destination is closed", () => {
    expect(
      plan({
        tasks: [task("t")],
        periods: [{ ...lastWeek, state: "closed" }],
        memberships: [commitment("c", "last-week", "t")],
      }),
    ).toEqual({ retire: [], create: [] });
    expect(
      plan({
        tasks: [task("t")],
        periods: [lastWeek, { ...thisWeek, state: "closed" }],
        memberships: [commitment("c", "last-week", "t")],
      }),
    ).toEqual({ retire: [], create: [] });
  });

  it("never rolls recurring, completed, cancelled or deleted tasks", () => {
    const result = plan({
      tasks: [
        task("template", { isTemplate: true, recurrence: { frequency: "weekly", interval: 1 } }),
        task("instance", { templateId: "template" }),
        task("own-rule", { recurrence: { frequency: "daily", interval: 1 } }),
        task("done", { status: "completed", completedAt: T1 }),
        task("cancelled", { status: "cancelled" }),
        task("deleted", { deletedAt: T1 }),
      ],
      periods: [lastWeek],
      memberships: ["template", "instance", "own-rule", "done", "cancelled", "deleted"].map((id) =>
        commitment(`c-${id}`, "last-week", id),
      ),
    });
    expect(result).toEqual({ retire: [], create: [] });
  });

  it("never moves backward or before a period has ended", () => {
    // Today is still inside the period: a device behind does nothing.
    expect(
      plan({
        tasks: [task("t")],
        periods: [thisWeek],
        memberships: [commitment("c", "this-week", "t")],
      }),
    ).toEqual({ retire: [], create: [] });
    // A period record starting on or after the current one is never a source.
    const odd = period("odd", "week", "2026-11-16", "2026-11-15");
    expect(
      plan({ tasks: [task("t")], periods: [odd], memberships: [commitment("c", "odd", "t")] }),
    ).toEqual({ retire: [], create: [] });
  });

  it("follows the account's week start", () => {
    // Sunday weeks: 8-14 Nov ended; today (Monday 16th) is in 15-21 Nov.
    const sundayWeek = period("sun", "week", "2026-11-08", "2026-11-14");
    const result = plan(
      { tasks: [task("t")], periods: [sundayWeek], memberships: [commitment("c", "sun", "t")] },
      0,
    );
    expect(result.create.map((c) => [c.startsOn, c.endsOn])).toEqual([
      ["2026-11-15", "2026-11-21"],
    ]);
  });

  it("is idempotent once the plan is applied", () => {
    const input: CommitmentRolloverInput = {
      tasks: [task("t")],
      periods: [lastWeek, thisWeek],
      memberships: [commitment("c", "last-week", "t", 3)],
    };
    const first = plan(input);
    const applied: CommitmentRolloverInput = {
      ...input,
      memberships: [
        { ...input.memberships[0]!, deletedAt: T1 },
        commitment("new", "this-week", "t", first.create[0]!.sortOrder),
      ],
    };
    expect(plan(applied)).toEqual({ retire: [], create: [] });
  });
});
