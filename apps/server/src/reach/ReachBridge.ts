/**
 * Collects answers to the Assistant's asks of coordinators on linked servers.
 * The callee keeps each answer as an activity under the push id the local
 * reactor would use; this polls each machine with open asks, appends every
 * answer into the Assistant with that same id (receipts make it idempotent)
 * and nudges the reactor to start it. Open asks live in `reach-requests.json`
 * so a restart loses none. Fork-owned; see
 * docs/internals/assistant-cross-server-reach.md.
 *
 * @module ReachBridge
 */
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import { AgentCompletionReactor } from "../orchestration/AgentCompletionReactor.ts";
import { agentPushId } from "../orchestration/agentProtocol.ts";
import { isOrchestrationCommandRejection } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { Reach } from "./Reach.ts";
import { ResultsResult } from "./reachProtocol.ts";

export const REACH_BRIDGE_INTERVAL = Duration.seconds(5);
const BACKOFF_MAX_MS = 60_000;
/** An ask whose machine has not answered for this long gets one "no answer" note and is dropped. */
export const REACH_ASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const ReachAskRecord = Schema.Struct({
  machineId: Schema.String,
  machineLabel: Schema.String,
  coordinatorThreadId: Schema.String,
  coordinatorTitle: Schema.String,
  /** The request's message id on the callee. */
  messageId: Schema.String,
  /** The Assistant thread here the answer goes to. */
  replyTo: Schema.String,
  askedAt: Schema.String,
});
export type ReachAskRecord = typeof ReachAskRecord.Type;

const StoreFileJson = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), asks: Schema.Array(ReachAskRecord) }),
);
const decodeStoreFile = Schema.decodeUnknownOption(StoreFileJson);
const encodeStoreFile = Schema.encodeSync(StoreFileJson);

export interface ReachBridgeShape {
  readonly track: (record: ReachAskRecord) => Effect.Effect<void>;
  readonly open: Effect.Effect<ReadonlyArray<ReachAskRecord>>;
  /** Stops waiting for answers owed to a thread, as when the Assistant moves away. */
  readonly dropFor: (replyTo: string) => Effect.Effect<void>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** One pass over every machine with open asks. Exposed for tests. */
  readonly pollOnce: Effect.Effect<void>;
}

/** A reference whose default tracks nothing, for code and tests that never link a machine. */
export const ReachBridge = Context.Reference<ReachBridgeShape>("t3/reach/ReachBridge", {
  defaultValue: () => ({
    track: () => Effect.void,
    dropFor: () => Effect.void,
    open: Effect.succeed([]),
    start: () => Effect.void,
    pollOnce: Effect.void,
  }),
});

const keyOf = (record: Pick<ReachAskRecord, "coordinatorThreadId" | "messageId">) =>
  agentPushId(record.coordinatorThreadId, record.messageId);

export const makeReachBridge = Effect.gen(function* () {
  const reach = yield* Reach;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const reactor = yield* AgentCompletionReactor;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = `${config.stateDir}/reach-requests.json`;
  const lock = yield* Semaphore.make(1);
  let cache: Array<ReachAskRecord> | null = null;
  const nextPollAt = new Map<string, number>();
  const failures = new Map<string, number>();

  const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const load = Effect.gen(function* () {
    if (cache !== null) return cache;
    const exists = yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      cache = [];
      return cache;
    }
    const raw = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    const decoded = decodeStoreFile(raw);
    if (Option.isNone(decoded)) {
      yield* Effect.logWarning("reach-requests.json could not be read; starting empty", {
        filePath,
      });
      yield* fileSystem.rename(filePath, `${filePath}.unreadable`).pipe(Effect.ignore);
      cache = [];
      return cache;
    }
    cache = [...decoded.value.asks];
    return cache;
  });

  const persist = (next: ReadonlyArray<ReachAskRecord>) =>
    writeFileStringAtomically({
      filePath,
      contents: encodeStoreFile({ version: 1, asks: next }),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.tap(() => Effect.sync(() => void (cache = [...next]))),
      Effect.catch((cause) => Effect.logWarning("reach-requests.json not written", { cause })),
    );

  const open = lock.withPermits(1)(load.pipe(Effect.map((records) => [...records])));

  const track = (record: ReachAskRecord) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const records = yield* load;
        if (records.some((entry) => keyOf(entry) === keyOf(record))) return;
        yield* persist([...records, record]);
      }),
    );

  const drop = (keys: ReadonlySet<string>) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const records = yield* load;
        const next = records.filter((entry) => !keys.has(keyOf(entry)));
        if (next.length !== records.length) yield* persist(next);
      }),
    );

  /** Appends one answer into the Assistant. Idempotent: the push id is the command id. */
  const deliver = (record: ReachAskRecord, id: string, text: string, title: string) =>
    Effect.gen(function* () {
      const recipient = yield* snapshots.getThreadShellById(ThreadId.make(record.replyTo)).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      if (recipient === undefined || recipient.archivedAt != null) {
        yield* Effect.logWarning("reach answer has no live Assistant to go to", {
          replyTo: record.replyTo,
        });
        return;
      }
      yield* engine
        .dispatch({
          type: "thread.message.user.append",
          commandId: CommandId.make(id),
          threadId: recipient.id,
          message: {
            messageId: MessageId.make(id),
            text,
            attachments: [],
            source: {
              kind: "agent",
              threadId: ThreadId.make(record.coordinatorThreadId),
              threadTitle: `${title} (on ${record.machineLabel})`,
            },
          },
          createdAt: yield* nowIso,
        })
        .pipe(
          Effect.catchIf(isOrchestrationCommandRejection, (error) =>
            Effect.logWarning("reach answer append rejected", { id, detail: error.message }),
          ),
        );
      yield* reactor.enqueueProject(recipient.projectId);
    });

  const pollMachine = (machineId: string, records: ReadonlyArray<ReachAskRecord>) =>
    Effect.gen(function* () {
      const first = records[0]!;
      const machine = { id: machineId, label: first.machineLabel };
      const outcome = yield* reach
        .call(
          machine,
          "results",
          {
            requests: records.map((record) => ({
              threadId: record.coordinatorThreadId,
              messageId: record.messageId,
            })),
          },
          { threadId: first.replyTo, threadTitle: "Assistant" },
          ResultsResult,
        )
        .pipe(Effect.result);
      const now = yield* nowMs;
      if (outcome._tag === "Failure") {
        const count = (failures.get(machineId) ?? 0) + 1;
        failures.set(machineId, count);
        nextPollAt.set(
          machineId,
          now + Math.min(BACKOFF_MAX_MS, Duration.toMillis(REACH_BRIDGE_INTERVAL) * 2 ** count),
        );
        // A machine gone a day: tell the Assistant once per ask, then stop waiting.
        const expired = records.filter(
          (record) =>
            now - DateTime.toEpochMillis(DateTime.makeUnsafe(record.askedAt)) >
            REACH_ASK_TIMEOUT_MS,
        );
        for (const record of expired) {
          yield* deliver(
            record,
            `${keyOf(record)}:timeout`,
            `Result from agent "${record.coordinatorTitle}" (threadId ${record.coordinatorThreadId}): no answer\n\n${record.machineLabel} has not answered for a day (${outcome.failure.detail}). Ask again when it is back.`,
            record.coordinatorTitle,
          );
        }
        if (expired.length > 0) yield* drop(new Set(expired.map(keyOf)));
        return;
      }
      failures.delete(machineId);
      nextPollAt.delete(machineId);
      const done = new Set<string>();
      for (const result of outcome.success.results) {
        const record = records.find(
          (entry) =>
            entry.coordinatorThreadId === result.threadId && entry.messageId === result.messageId,
        );
        if (record === undefined) continue;
        yield* deliver(record, keyOf(record), result.text, result.threadTitle);
        done.add(keyOf(record));
      }
      for (const lost of outcome.success.lost) {
        const record = records.find(
          (entry) =>
            entry.coordinatorThreadId === lost.threadId && entry.messageId === lost.messageId,
        );
        if (record === undefined) continue;
        yield* deliver(
          record,
          keyOf(record),
          `Result from agent "${record.coordinatorTitle}" (threadId ${record.coordinatorThreadId}): failed\n\nThat coordinator is gone on ${record.machineLabel}, so no answer will come.`,
          record.coordinatorTitle,
        );
        done.add(keyOf(record));
      }
      if (done.size > 0) yield* drop(done);
    });

  const pollOnce = Effect.gen(function* () {
    const records = yield* open;
    const byMachine = new Map<string, Array<ReachAskRecord>>();
    for (const record of records) {
      byMachine.set(record.machineId, [...(byMachine.get(record.machineId) ?? []), record]);
    }
    const now = yield* nowMs;
    yield* Effect.forEach(
      [...byMachine].filter(([machineId]) => (nextPollAt.get(machineId) ?? 0) <= now),
      ([machineId, machineRecords]) =>
        pollMachine(machineId, machineRecords).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("reach answer poll failed", { machineId, cause: String(cause) }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  });

  const loop = Effect.gen(function* () {
    while (true) {
      yield* pollOnce;
      yield* Effect.sleep(REACH_BRIDGE_INTERVAL);
    }
  });

  const dropFor = (replyTo: string) =>
    open.pipe(
      Effect.flatMap((records) =>
        drop(new Set(records.filter((entry) => entry.replyTo === replyTo).map(keyOf))),
      ),
    );

  return {
    track,
    open,
    dropFor,
    start: () => forkParked(loop),
    pollOnce,
  } satisfies ReachBridgeShape;
});

/** Starts polling when built, parked behind server activation like the reactors. */
export const ReachBridgeLive = Layer.effect(
  ReachBridge,
  Effect.gen(function* () {
    const bridge = yield* makeReachBridge;
    yield* bridge.start();
    return bridge;
  }),
);
