/**
 * Keeps `taskAuthority` current: at build (before clients connect) from this
 * server's own Projects, its Task Sync account and the stored answers of
 * linked machines, then every few minutes from fresh `describe` calls, after
 * each Task Sync apply and when the rollover setting changes. A machine that
 * does not answer keeps its stored answer, so a sleeping authority stays the
 * authority. When this server's own Task Sync account or Assistant changes it
 * pokes its linked machines, so they look again at once.
 * Fork-owned; see docs/internals/assistant-cross-server-reach.md.
 *
 * @module TaskAuthorityLive
 */
import { findGlobalAssistantProject } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TaskSyncService } from "../taskSync/TaskSyncService.ts";
import { Reach } from "./Reach.ts";
import { DescribeResult } from "./reachProtocol.ts";
import {
  accountOf,
  type AssistantAnswer,
  AUTHORITY_FRESH_MS,
  decideTaskAuthority,
  hostsAssistant,
  knownAssistantHosts,
  noteAssistantHost,
  notifyRolloverPermitGained,
  noteRolloverGap,
  describeTaskState,
  registerTaskAuthorityRefresh,
  setTaskAuthority,
  setTaskAuthorityLiveState,
  type TaskAuthorityDecision,
} from "./taskAuthority.ts";

export const TASK_AUTHORITY_REFRESH = Duration.minutes(5);

const KnownJson = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      hosts: Schema.Boolean,
      at: Schema.Number,
      task: Schema.optional(
        Schema.Struct({
          at: Schema.Number,
          account: Schema.NullOr(Schema.String),
          rolls: Schema.Boolean,
          rollover: Schema.Struct({
            enabled: Schema.Boolean,
            setAt: Schema.NullOr(Schema.String),
          }),
        }),
      ),
    }),
  ),
);
const decodeKnown = Schema.decodeUnknownEffect(KnownJson);
const encodeKnown = Schema.encodeEffect(KnownJson);

const describe = (decision: TaskAuthorityDecision) => {
  if (decision.authority) return "this server is the task authority";
  switch (decision.reason) {
    case "unsynced":
      return `this server is not signed in to Task Sync; tasks are held by ${decision.deferTo.label}`;
    case "synced":
      return `tasks defer to ${decision.deferTo.label}, the synced server that runs the Assistant`;
    default:
      return `tasks defer to ${decision.deferTo.label}, which hosts the Assistant`;
  }
};

export const TaskAuthorityLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const reach = yield* Reach;
    const snapshots = yield* ProjectionSnapshotQuery;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const settingsService = yield* ServerSettingsService;
    // Optional: builds and tests without Task Sync decide by the Assistant alone.
    const taskSync = yield* Effect.serviceOption(TaskSyncService);
    const orchestration = yield* Effect.serviceOption(OrchestrationEngineService);
    const filePath = `${config.stateDir}/reach-assistants.json`;
    for (const [id, answer] of Object.entries(
      yield* fileSystem.readFileString(filePath).pipe(
        Effect.flatMap(decodeKnown),
        Effect.orElseSucceed((): Record<string, AssistantAnswer> => ({})),
      ),
    )) {
      noteAssistantHost(id, answer);
    }
    const known = knownAssistantHosts();
    let lastText: string | null = null;
    let lastOwn: string | null = null;
    let lastRolls = false;
    let started = false;
    let refreshedAt: number | null = null;
    let gapWarnedAt: number | null = null;
    const refreshLock = yield* Semaphore.make(1);

    const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));

    /** Tells linked machines to look again; older builds refuse the op, which is fine. */
    const poke = Effect.gen(function* () {
      for (const machine of yield* reach.machines) {
        yield* reach
          .call(
            machine,
            "authority.poke",
            {},
            { threadId: "", threadTitle: "" },
            Schema.Struct({ ok: Schema.Boolean }),
          )
          .pipe(Effect.ignore);
      }
    });

    const recompute = Effect.gen(function* () {
      const selfId = yield* environment.getEnvironmentId;
      const snapshot = yield* snapshots.getShellSnapshot().pipe(Effect.option);
      const localAssistant =
        snapshot._tag === "Some" &&
        findGlobalAssistantProject(snapshot.value.projects) !== undefined;
      const selfAccount = Option.isSome(taskSync) ? yield* taskSync.value.syncedAccountKey : null;
      const settings = yield* settingsService.getSettings.pipe(Effect.option);
      const local = {
        enabled: Option.isSome(settings) && settings.value.taskRolloverToCurrentPeriod,
        setAt: Option.isSome(settings) ? (settings.value.taskRolloverSetAt ?? null) : null,
      };
      const machines = yield* reach.machines;
      const now = yield* nowMs;
      const decision = decideTaskAuthority({
        selfId,
        localAssistant,
        selfAccount,
        linked: machines.map((machine) => ({
          id: machine.id,
          label: machine.label,
          hasAssistant: hostsAssistant(known.get(machine.id), now),
          account: accountOf(known.get(machine.id), now),
        })),
      });
      setTaskAuthorityLiveState({
        selfAccount,
        localAssistant,
        local,
        machines: machines.map((machine) => ({ id: machine.id, label: machine.label })),
        refreshedAt,
      });
      setTaskAuthority(decision);
      const text = describe(decision);
      if (text !== lastText) {
        lastText = text;
        yield* Effect.logInfo(`task authority: ${text}`);
      }
      const gapSince = noteRolloverGap(now);
      if (gapSince === null) {
        gapWarnedAt = null;
      } else if (gapWarnedAt === null) {
        gapWarnedAt = now;
        yield* Effect.logWarning(
          "commitment rollover is on, but no linked server has rolled commitments since " +
            DateTime.formatIso(DateTime.makeUnsafe(gapSince)),
        );
      }
      // This server's own part changed (a sign-in, sign-out, Assistant moved in
      // or out, it started or stopped rolling): tell linked machines now rather
      // than at their next refresh, so a handover takes seconds.
      const rolls = describeTaskState(now)?.rolls === true;
      const own = `${selfAccount ?? "-"}|${localAssistant}|${rolls}`;
      const changed = lastOwn !== null && own !== lastOwn;
      lastOwn = own;
      if (changed) yield* Effect.forkDetach(poke);
      // Not during the build: rollover's own start-up pass covers that.
      if (rolls && !lastRolls && started) notifyRolloverPermitGained();
      lastRolls = rolls;
    });

    const refresh = refreshLock.withPermits(1)(
      Effect.gen(function* () {
        for (const machine of yield* reach.machines) {
          const described = yield* reach
            .call(machine, "describe", {}, { threadId: "", threadTitle: "" }, DescribeResult)
            .pipe(Effect.option);
          if (described._tag === "Some") {
            const at = yield* nowMs;
            const tasks = described.value.tasks;
            noteAssistantHost(machine.id, {
              hosts: described.value.assistant !== null,
              at,
              ...(tasks === undefined ? {} : { task: { at, ...tasks } }),
            });
          }
        }
        refreshedAt = yield* nowMs;
        yield* encodeKnown(Object.fromEntries(known)).pipe(
          Effect.flatMap((contents) => writeFileStringAtomically({ filePath, contents })),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.ignore,
        );
        yield* recompute;
      }),
    );

    const logFailure = (label: string) =>
      Effect.catchCause((cause: unknown) => Effect.logWarning(label, { cause: String(cause) }));

    const ensureFresh = Effect.gen(function* () {
      if ((yield* reach.machines).length === 0) return;
      const now = yield* nowMs;
      if (refreshedAt !== null && now - refreshedAt <= AUTHORITY_FRESH_MS) {
        yield* recompute;
        return;
      }
      yield* refresh;
    });

    // Before clients connect, from what is stored; then keep it fresh.
    yield* recompute;
    started = true;
    registerTaskAuthorityRefresh(
      refresh.pipe(logFailure("task authority refresh failed")),
      ensureFresh.pipe(logFailure("task authority refresh failed")),
    );
    yield* forkParked(
      Effect.gen(function* () {
        while (true) {
          yield* refresh.pipe(logFailure("task authority refresh failed"));
          yield* Effect.sleep(TASK_AUTHORITY_REFRESH);
        }
      }),
    );
    // The first merge after a sign-in makes this server synced.
    if (Option.isSome(taskSync)) {
      yield* forkParked(
        Stream.runForEach(taskSync.value.applied, () =>
          recompute.pipe(logFailure("task authority recompute failed")),
        ),
      );
    }
    // The Assistant created, moved in or out, archived: this server's part changed.
    if (Option.isSome(orchestration)) {
      const events = yield* orchestration.value.subscribeDomainEvents;
      yield* forkParked(
        events.pipe(
          Stream.filter((event) => event.type.startsWith("project.")),
          Stream.debounce(Duration.seconds(1)),
          Stream.runForEach(() => recompute.pipe(logFailure("task authority recompute failed"))),
        ),
      );
    }
    yield* forkParked(
      Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* settingsService.subscribeChanges;
          yield* Stream.runForEach(changes, () =>
            recompute.pipe(logFailure("task authority recompute failed")),
          );
        }),
      ),
    );
  }),
);
