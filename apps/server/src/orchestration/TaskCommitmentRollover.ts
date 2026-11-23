/**
 * Commitment rollover. Fork-owned. When a week, month or year ends, its
 * unfinished commitments move to the period of the same horizon that holds
 * today, by the rule agreed with Lucive so both apps move them the same way.
 *
 * Gated by `taskRolloverToCurrentPeriod` (off by default; across servers on
 * one Task Sync account the latest choice wins) and by task authority: only
 * one server rolls (`taskRolloverPermit`). Synced tasks are
 * moved by Task Sync on its own planning records: the old commitment is
 * retired and a new one created, the task row is never rewritten, and the
 * result reaches the event store like a pull. Tasks only this machine holds
 * (Task Sync off, or never synced) move with an ordinary `task.update`.
 *
 * Runs after activation, whenever the local date changes (checked on a short
 * timer), after each Task Sync apply, when the setting is switched on, and
 * before task reads (`beforeRead`). Runs are serialized and idempotent: after
 * one pass no expired commitment is left to move.
 *
 * @module TaskCommitmentRollover
 */
import {
  CommandId,
  getTaskWeekStartsOn,
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
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  ensureFreshTaskAuthority,
  onRolloverPermitGained,
  taskRolloverPermit,
} from "../reach/taskAuthority.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TaskSyncService } from "../taskSync/TaskSyncService.ts";
import { isOrchestrationCommandRejection } from "./Errors.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const COMMAND_PREFIX = "task-rollover:";
/** How often the local date is checked. A move lands at most this long after midnight. */
const DATE_CHECK_INTERVAL = "5 minutes";
/** How long a read waits for a catch-up; a slower one lands as live updates. */
const READ_WAIT = "2 seconds";

type PeriodHome = Extract<TaskHome, { readonly kind: "period" }>;

export interface CommitmentMove {
  readonly task: Task;
  readonly newHome: PeriodHome;
}

/** Whether the setting asks for rollover. */
export function rolloverEnabled(
  settings: Pick<ServerSettings, "taskRolloverToCurrentPeriod">,
): boolean {
  return settings.taskRolloverToCurrentPeriod;
}

/**
 * Expired commitments among tasks only this machine holds, each with the
 * period of its horizon that contains `today`. Only plain todo tasks move:
 * completed or cancelled ones, waiting proposals and repeating tasks stay
 * where they are, and nothing moves to a period that does not start after
 * its current one. The read model holds no deleted tasks.
 */
export function expiredCommitmentMoves(
  tasks: ReadonlyArray<Task>,
  today: string,
  weekStartsOn: number = getTaskWeekStartsOn(),
): CommitmentMove[] {
  const moves: CommitmentMove[] = [];
  for (const task of tasks) {
    const home = task.home;
    if (home.kind !== "period" || home.endsOn >= today) continue;
    if (task.status !== "todo" || isProposedTask(task)) continue;
    if (task.recurrence !== undefined || task.seriesId !== undefined) continue;
    const target = taskPeriodFor(home.horizon, today, weekStartsOn);
    if (target.startsOn <= home.startsOn) continue;
    moves.push({ task, newHome: { kind: "period", horizon: home.horizon, ...target } });
  }
  return moves;
}

export class TaskCommitmentRollover extends Context.Service<
  TaskCommitmentRollover,
  {
    /** Rolls expired commitments now when the setting is on. Returns how many moved. */
    readonly runCatchUp: Effect.Effect<number>;
    /**
     * Before serving tasks: catches up when today has not been handled yet,
     * waiting a short while for it. Free once today is done.
     */
    readonly beforeRead: Effect.Effect<void>;
  }
>()("t3/orchestration/TaskCommitmentRollover") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettingsService;
  // Optional: tests and builds without Task Sync treat every task as local.
  const taskSync = yield* Effect.serviceOption(TaskSyncService);
  const lock = yield* Semaphore.make(1);
  /** The last local day a full pass completed. */
  let lastDay: string | null = null;

  const today = DateTime.now.pipe(Effect.map((now) => localTaskDate(DateTime.toEpochMillis(now))));

  const catchUp = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    // A machine that slept looks at its linked machines again before rolling
    // on what it knew before.
    yield* ensureFreshTaskAuthority;
    // Only the task authority rolls, only with the account-wide setting on,
    // and never while another server still says it rolls: two servers on one
    // Task Sync account would each create a new membership for the same
    // commitment.
    const permit = taskRolloverPermit(
      {
        enabled: rolloverEnabled(settings),
        setAt: settings.taskRolloverSetAt ?? null,
      },
      DateTime.toEpochMillis(yield* DateTime.now),
    );
    if (!permit.rolls) return 0;
    const now = yield* DateTime.now;
    const createdAt = DateTime.formatIso(now);
    const day = localTaskDate(DateTime.toEpochMillis(now));

    // Synced tasks first: Task Sync moves their commitments and refuses
    // until it has the account's week start this session.
    let synced: ReadonlySet<string> = new Set();
    let moved = 0;
    if (Option.isSome(taskSync)) {
      const result = yield* taskSync.value.rollExpiredCommitments(day);
      if (result.state === "waiting") return 0;
      if (result.state === "done") {
        synced = result.syncedTaskIds;
        moved += result.created;
        if (result.retired > 0) {
          yield* Effect.logInfo("rolled synced commitments", {
            created: result.created,
            retired: result.retired,
            today: day,
          });
        }
      }
    }

    const model = yield* snapshots.getCommandReadModel();
    const local = (model.tasks ?? []).filter((task) => !synced.has(task.id));
    for (const { task, newHome } of expiredCommitmentMoves(local, day)) {
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
    lastDay = day;
    if (moved > 0) yield* Effect.logInfo("rolled commitments forward", { moved, today: day });
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

  /** Runs only when the local date moved past the last completed run. */
  const onTick = Effect.gen(function* () {
    if ((yield* today) === lastDay) return;
    yield* runCatchUp;
  });

  const beforeRead = Effect.gen(function* () {
    if ((yield* today) === lastDay) return;
    // Detached, so a slow pass finishes even when the read stops waiting.
    const fiber = yield* Effect.forkDetach(runCatchUp);
    yield* Fiber.join(fiber).pipe(Effect.timeoutOption(READ_WAIT), Effect.asVoid);
  });

  yield* forkParked(runCatchUp);
  // This server just took over rolling (a handover finished): catch up now
  // rather than at the next date check.
  const context = yield* Effect.context<never>();
  const runForkNow = Effect.runForkWith(context);
  yield* Effect.acquireRelease(
    Effect.sync(() => onRolloverPermitGained(() => void runForkNow(runCatchUp))),
    (unsubscribe) => Effect.sync(unsubscribe),
  );
  yield* forkParked(
    onTick.pipe(Effect.repeat(Schedule.spaced(DATE_CHECK_INTERVAL)), Effect.asVoid),
  );
  if (Option.isSome(taskSync)) {
    // Pulled records may arrive already expired, or the week start may have
    // just arrived: handle them right after each apply.
    yield* forkParked(Stream.runForEach(taskSync.value.applied, () => runCatchUp));
  }
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

  return { runCatchUp, beforeRead } satisfies TaskCommitmentRollover["Service"];
});

export const layer = Layer.effect(TaskCommitmentRollover, make);
