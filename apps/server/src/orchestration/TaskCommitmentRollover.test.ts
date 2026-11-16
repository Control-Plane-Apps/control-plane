import {
  DEFAULT_SERVER_SETTINGS,
  getTaskWeekStartsOn,
  setTaskWeekStartsOn,
  TaskId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type Task,
  type TaskHome,
} from "@t3tools/contracts";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerActivation } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import {
  expiredCommitmentMoves,
  rolloverEnabled,
  TaskCommitmentRollover,
  layer as rolloverLayer,
} from "./TaskCommitmentRollover.ts";

const AT = "2026-11-01T00:00:00.000Z";

function task(id: string, home: TaskHome, extra: Partial<Task> = {}): Task {
  return {
    id: TaskId.make(id),
    title: `Task ${id}`,
    status: "todo",
    home,
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  };
}

const week = (startsOn: string, endsOn: string): TaskHome => ({
  kind: "period",
  horizon: "week",
  startsOn,
  endsOn,
});
const month = (startsOn: string, endsOn: string): TaskHome => ({
  kind: "period",
  horizon: "month",
  startsOn,
  endsOn,
});
const year = (startsOn: string, endsOn: string): TaskHome => ({
  kind: "period",
  horizon: "year",
  startsOn,
  endsOn,
});

// Monday 16 November 2026.
const TODAY = "2026-11-16";

describe("expiredCommitmentMoves", () => {
  let savedWeekStart = 1;
  beforeEach(() => {
    savedWeekStart = getTaskWeekStartsOn();
    setTaskWeekStartsOn(1);
  });
  afterEach(() => setTaskWeekStartsOn(savedWeekStart));

  it("moves an expired week, month and year into the current period", () => {
    const moves = expiredCommitmentMoves(
      [
        task("w", week("2026-11-09", "2026-11-15"), { orderKey: "m" as never }),
        task("m", month("2026-10-01", "2026-10-31")),
        task("y", year("2025-01-01", "2025-12-31")),
      ],
      TODAY,
    );
    assert.deepStrictEqual(
      moves.map((move) => [move.task.id, move.newHome]),
      [
        ["w", week("2026-11-16", "2026-11-22")],
        ["m", month("2026-11-01", "2026-11-30")],
        ["y", year("2026-01-01", "2026-12-31")],
      ],
    );
    // The task itself is passed through untouched, order key included.
    assert.strictEqual(moves[0]!.task.orderKey, "m");
  });

  it("lands a commitment several periods old in the current period", () => {
    const moves = expiredCommitmentMoves(
      [
        task("w", week("2026-09-07", "2026-09-13")),
        task("m", month("2026-02-01", "2026-02-28")),
        task("y", year("2022-01-01", "2022-12-31")),
      ],
      TODAY,
    );
    assert.deepStrictEqual(
      moves.map((move) => move.newHome),
      [
        week("2026-11-16", "2026-11-22"),
        month("2026-11-01", "2026-11-30"),
        year("2026-01-01", "2026-12-31"),
      ],
    );
  });

  it("leaves current and future periods alone, so a rerun does nothing", () => {
    const tasks = [
      task("w", week("2026-11-16", "2026-11-22")),
      task("w-next", week("2026-11-23", "2026-11-29")),
      task("m", month("2026-11-01", "2026-11-30")),
      task("y", year("2026-01-01", "2026-12-31")),
      task("y-next", year("2027-01-01", "2027-12-31")),
    ];
    assert.deepStrictEqual(expiredCommitmentMoves(tasks, TODAY), []);
    const rolled = expiredCommitmentMoves([task("old", week("2026-11-09", "2026-11-15"))], TODAY);
    const after = rolled.map((move) => ({ ...move.task, home: move.newHome }));
    assert.deepStrictEqual(expiredCommitmentMoves(after, TODAY), []);
  });

  it("leaves days and backlogs alone", () => {
    const tasks = [
      task("d", { kind: "date", date: "2026-11-01" }),
      task("b", { kind: "backlog", horizon: null }),
      task("bw", { kind: "backlog", horizon: "week" }),
    ];
    assert.deepStrictEqual(expiredCommitmentMoves(tasks, TODAY), []);
  });

  it("leaves completed, cancelled, proposed and repeating tasks alone", () => {
    const old = week("2026-11-09", "2026-11-15");
    const tasks = [
      task("done", old, { status: "completed", completedAt: AT }),
      task("cancelled", old, { status: "cancelled" }),
      task("proposed", old, {
        proposal: {
          projectId: "project-1" as never,
          threadId: "thread-1" as never,
          proposedAt: AT,
        },
      }),
      task("repeat", old, { recurrence: { frequency: "weekly", interval: 1 } }),
    ];
    assert.deepStrictEqual(expiredCommitmentMoves(tasks, TODAY), []);
  });

  it("moves an accepted proposal like any task", () => {
    const moves = expiredCommitmentMoves(
      [
        task("accepted", week("2026-11-09", "2026-11-15"), {
          proposal: {
            projectId: "project-1" as never,
            threadId: "thread-1" as never,
            proposedAt: AT,
            acceptedAt: AT,
          },
        }),
      ],
      TODAY,
    );
    assert.strictEqual(moves.length, 1);
  });

  it("follows the account's week start", () => {
    setTaskWeekStartsOn(0);
    // Sunday-start week 8-14 Nov ended; today (Monday 16th) is in 15-21 Nov.
    const moves = expiredCommitmentMoves([task("w", week("2026-11-08", "2026-11-14"))], TODAY);
    assert.deepStrictEqual(
      moves.map((move) => move.newHome),
      [week("2026-11-15", "2026-11-21")],
    );
    // Still current under a Sunday start: nothing to do.
    assert.deepStrictEqual(
      expiredCommitmentMoves([task("w", week("2026-11-15", "2026-11-21"))], TODAY),
      [],
    );
  });
});

describe("rolloverEnabled", () => {
  it("is off by default", () => {
    assert.strictEqual(rolloverEnabled(DEFAULT_SERVER_SETTINGS), false);
    assert.strictEqual(
      rolloverEnabled({ ...DEFAULT_SERVER_SETTINGS, tasks: { rollCommitmentsForward: true } }),
      true,
    );
  });
});

describe("TaskCommitmentRollover", () => {
  const expired = task("w", week("2026-11-09", "2026-11-15"));

  const harness = (enabled: boolean) =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<OrchestrationCommand[]>([]);
      // Parked forever: only the explicit catch-up runs in these tests.
      const activation = yield* Deferred.make<void>();
      const dependencies = Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery)({
          getCommandReadModel: () =>
            Effect.succeed({ tasks: [expired] } as unknown as OrchestrationReadModel),
        }),
        Layer.mock(OrchestrationEngineService)({
          readEvents: () => Stream.empty,
          dispatch: (command) =>
            Ref.update(dispatched, (list) => [...list, command]).pipe(Effect.as({ sequence: 1 })),
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
        ServerSettings.layerTest({ tasks: { rollCommitmentsForward: enabled } }),
        Layer.succeed(ServerActivation, Deferred.await(activation)),
      );
      return { dispatched, layer: rolloverLayer.pipe(Layer.provide(dependencies)) };
    });

  // Noon UTC on Monday 16 November 2026: the 16th in any zone within 11 hours of UTC.
  const noonToday = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-16T12:00:00.000Z"));

  it.effect("does nothing while the setting is off", () =>
    Effect.gen(function* () {
      const { dispatched, layer } = yield* harness(false);
      yield* TestClock.setTime(noonToday);
      const moved = yield* Effect.gen(function* () {
        const rollover = yield* TaskCommitmentRollover;
        return yield* rollover.runCatchUp;
      }).pipe(Effect.provide(layer));
      assert.strictEqual(moved, 0);
      assert.deepStrictEqual(yield* Ref.get(dispatched), []);
    }),
  );

  it.effect("moves an expired commitment with task.update when on", () =>
    Effect.gen(function* () {
      const { dispatched, layer } = yield* harness(true);
      yield* TestClock.setTime(noonToday);
      const moved = yield* Effect.gen(function* () {
        const rollover = yield* TaskCommitmentRollover;
        return yield* rollover.runCatchUp;
      }).pipe(Effect.provide(layer));
      assert.strictEqual(moved, 1);
      const [command] = yield* Ref.get(dispatched);
      assert.strictEqual(command?.type, "task.update");
      if (command?.type !== "task.update") return;
      assert.strictEqual(command.taskId, expired.id);
      assert.deepStrictEqual(command.patch, { home: week("2026-11-16", "2026-11-22") });
      assert.isTrue(command.commandId.startsWith("task-rollover:w:week:2026-11-16:"));
    }),
  );
});
