/**
 * Commitment rollover. Fork-owned. When a week, month or year ends, its
 * unfinished commitments move to the period of the same horizon that holds
 * today, so a commitment several periods old lands in the current one.
 *
 * Gated by `tasks.rollCommitmentsForward` (off by default): Lucive syncs the
 * same tasks, so only one app may apply the rule. Each move is an ordinary
 * `task.update` of the task's home, which Task Sync pushes like a user edit
 * (it retires the old commitment and adds the new one). The task keeps its
 * order key. After a move the home ends on or after today, so a rerun finds
 * nothing to do.
 *
 * Runs once after activation, whenever the local date changes (checked on a
 * short timer) and when the setting is switched on.
 *
 * @module TaskCommitmentRollover
 */
import {
  CommandId,
  isProposedTask,
  localTaskDate,
  taskPeriodFor,
  type ServerSettings,
  type Task,
  type TaskHome,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TaskSyncService } from "../taskSync/TaskSyncService.ts";
import { isOrchestrationCommandRejection } from "./Errors.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const COMMAND_PREFIX = "task-rollover:";
/** How often the local date is checked. A move lands at most this long after midnight. */
const DATE_CHECK_INTERVAL = "5 minutes";

type PeriodHome = Extract<TaskHome, { readonly kind: "period" }>;

export interface CommitmentMove {
  readonly task: Task;
  readonly newHome: PeriodHome;
}

/** Whether the setting asks for rollover. */
export function rolloverEnabled(settings: Pick<ServerSettings, "tasks">): boolean {
  return settings.tasks.rollCommitmentsForward;
}

/**
 * Open commitments whose period ended before `today`, each with the period of
 * its horizon that contains `today`. Only plain todo tasks move: completed or
 * cancelled ones, waiting proposals and repeating tasks stay where they are.
 * The read model holds no deleted tasks.
 */
export function expiredCommitmentMoves(
  tasks: ReadonlyArray<Task>,
  today: string,
): CommitmentMove[] {
  const moves: CommitmentMove[] = [];
  for (const task of tasks) {
    const home = task.home;
    if (home.kind !== "period" || home.endsOn >= today) continue;
    if (task.status !== "todo" || task.recurrence !== undefined || isProposedTask(task)) continue;
    moves.push({
      task,
      newHome: { kind: "period", horizon: home.horizon, ...taskPeriodFor(home.horizon, today) },
    });
  }
  return moves;
}

export class TaskCommitmentRollover extends Context.Service<
  TaskCommitmentRollover,
  {
    /** Moves expired commitments now when the setting is on. Returns how many moved. */
    readonly runCatchUp: Effect.Effect<number>;
  }
>()("t3/orchestration/TaskCommitmentRollover") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettingsService;
  // Reading Task Sync loads its saved state, which sets the account's week
  // start before any week is computed. Optional: tests run without it.
  const taskSync = yield* Effect.serviceOption(TaskSyncService);
  const lock = yield* Semaphore.make(1);
  let lastDay: string | null = null;

  const catchUp = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    if (!rolloverEnabled(settings)) return 0;
    if (Option.isSome(taskSync)) yield* taskSync.value.syncedTaskIds;
    const now = yield* DateTime.now;
    const createdAt = DateTime.formatIso(now);
    const today = localTaskDate(DateTime.toEpochMillis(now));
    lastDay = today;
    const model = yield* snapshots.getCommandReadModel();
    const moves = expiredCommitmentMoves(model.tasks ?? [], today);
    let moved = 0;
    for (const { task, newHome } of moves) {
      yield* engine
        .dispatch({
          type: "task.update",
          // Per task version: a retry of the same move is deduplicated, a
          // later move of the same task gets its own id.
          commandId: CommandId.make(
            `${COMMAND_PREFIX}${task.id}:${newHome.horizon}:${newHome.startsOn}:${task.updatedAt}`,
          ),
          taskId: task.id,
          patch: { home: newHome },
          createdAt,
        })
        .pipe(
          Effect.tap(() => Effect.sync(() => (moved += 1))),
          // One task's failure never holds up the rest. A refusal means the
          // task changed under us (completed, deleted); the next run sees it.
          Effect.catch((error) =>
            isOrchestrationCommandRejection(error)
              ? Effect.logDebug("task rollover skipped", { taskId: task.id, detail: error.message })
              : Effect.logWarning("task rollover failed for a task", {
                  taskId: task.id,
                  detail: error.message,
                }),
          ),
        );
    }
    if (moved > 0) yield* Effect.logInfo("rolled commitments forward", { moved, today });
    return moved;
  });

  const runCatchUp = lock
    .withPermits(1)(catchUp)
    .pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("task rollover failed", { cause: Cause.pretty(cause) }).pipe(
              Effect.as(0),
            ),
      ),
    );

  /** Runs only when the local date moved past the last run. */
  const onTick = Effect.gen(function* () {
    const today = localTaskDate(DateTime.toEpochMillis(yield* DateTime.now));
    if (today === lastDay) return;
    yield* runCatchUp;
  });

  yield* forkParked(runCatchUp);
  yield* forkParked(
    onTick.pipe(Effect.repeat(Schedule.spaced(DATE_CHECK_INTERVAL)), Effect.asVoid),
  );
  // Subscribe before reading the current value so a flip in between is seen.
  yield* forkParked(
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* settingsService.subscribeChanges;
        let wasEnabled = yield* settingsService.getSettings.pipe(
          Effect.map(rolloverEnabled),
          Effect.orElseSucceed(() => false),
        );
        yield* Stream.runForEach(changes, (settings) => {
          const enabled = rolloverEnabled(settings);
          const switchedOn = enabled && !wasEnabled;
          wasEnabled = enabled;
          return switchedOn ? runCatchUp.pipe(Effect.asVoid) : Effect.void;
        });
      }),
    ),
  );

  return { runCatchUp } satisfies TaskCommitmentRollover["Service"];
});

export const layer = Layer.effect(TaskCommitmentRollover, make);
