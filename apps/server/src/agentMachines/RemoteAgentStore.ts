/**
 * The home's record of agents it started on linked machines. One JSON file in
 * the state dir, written atomically: a fork migration would renumber on every
 * upstream sync, and the file holds a few dozen small records at most.
 * Fork-owned; see docs/internals/multi-machine-agents.md.
 *
 * @module RemoteAgentStore
 */
import { RemoteAgentRecord } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as SqlClient from "effect/unstable/sql/SqlClient";
import { projectMoveFenceOwner, withProjectWriter } from "../reach/projectMoveFence.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";

/** Settled and lost records are kept this long, then pruned. */
export const REMOTE_AGENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export { RemoteAgentRequest, RemoteAgentQueuedSend, RemoteAgentRecord } from "@t3tools/contracts";

const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  agents: Schema.Array(RemoteAgentRecord),
});

const StoreFileJson = Schema.fromJsonString(StoreFile);
const decodeStoreFile = Schema.decodeUnknownOption(StoreFileJson);
const encodeStoreFile = Schema.encodeSync(StoreFileJson);

export class RemoteAgentStoreError extends Schema.TaggedError<RemoteAgentStoreError>()(
  "RemoteAgentStoreError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export interface RemoteAgentStoreShape {
  readonly list: Effect.Effect<ReadonlyArray<RemoteAgentRecord>, RemoteAgentStoreError>;
  /** Verify the on-disk association inventory before a coordinator move. */
  readonly listForMove: Effect.Effect<ReadonlyArray<RemoteAgentRecord>, RemoteAgentStoreError>;
  /** Atomically replace this fenced Project's associations, preserving records belonging to others. */
  readonly replaceForMove: (
    projectId: string,
    moveId: string,
    agents: readonly RemoteAgentRecord[],
    verifyOnly: boolean,
    localThreads?: readonly string[],
  ) => Effect.Effect<void, RemoteAgentStoreError>;
  readonly get: (
    threadId: string,
  ) => Effect.Effect<Option.Option<RemoteAgentRecord>, RemoteAgentStoreError>;
  readonly put: (record: RemoteAgentRecord) => Effect.Effect<void, RemoteAgentStoreError>;
  /** Applies `change` to one record under the write lock; none when it is missing. */
  readonly update: (
    threadId: string,
    change: (record: RemoteAgentRecord) => RemoteAgentRecord,
  ) => Effect.Effect<Option.Option<RemoteAgentRecord>, RemoteAgentStoreError>;
  readonly remove: (threadId: string) => Effect.Effect<void, RemoteAgentStoreError>;
}

export class RemoteAgentStore extends Context.Service<RemoteAgentStore, RemoteAgentStoreShape>()(
  "t3/agentMachines/RemoteAgentStore",
) {}

const isRemoteAgentStoreError = Schema.is(RemoteAgentStoreError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = `${config.stateDir}/remote-agents.json`;
  const lock = yield* Semaphore.make(1);

  const fail = (detail: string) => (cause: unknown) => new RemoteAgentStoreError({ detail, cause });

  // Take the SQLite write lock before reading the file. The registry is one atomic
  // file shared by all Projects and every server using this state directory.
  const registryWrite = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(
        sql`UPDATE project_move_fences SET move_id=move_id WHERE 0`.pipe(Effect.andThen(work)),
      )
      .pipe(
        Effect.mapError((cause) =>
          isRemoteAgentStoreError(cause) ? cause : fail("write registry")(cause),
        ),
      );
  const read = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(filePath).pipe(Effect.mapError(fail("read")))))
      return Option.some([] as RemoteAgentRecord[]);
    const raw = yield* fileSystem.readFileString(filePath).pipe(Effect.mapError(fail("read")));
    return Option.map(decodeStoreFile(raw), (stored) => [...stored.agents]);
  });
  const load = Effect.gen(function* () {
    const records = yield* read;
    if (Option.isSome(records)) return records.value;
    // Re-read under the shared writer lock before setting aside a legacy unreadable file.
    return yield* registryWrite(
      Effect.gen(function* () {
        const current = yield* read;
        if (Option.isSome(current)) return current.value;
        yield* Effect.logWarning("remote-agents.json could not be read; starting empty", {
          filePath,
        });
        yield* fileSystem
          .rename(filePath, filePath + ".unreadable")
          .pipe(Effect.catch(() => Effect.void));
        return [] as RemoteAgentRecord[];
      }),
    );
  });

  const prune = (
    records: ReadonlyArray<RemoteAgentRecord>,
    nowMs: number,
    fenced: ReadonlySet<string>,
  ) =>
    records.filter(
      (record) =>
        fenced.has(record.homeProjectId) ||
        record.endedAt === null ||
        nowMs - DateTime.toEpochMillis(DateTime.makeUnsafe(record.endedAt)) <
          REMOTE_AGENT_RETENTION_MS,
    );

  const persist = (next: ReadonlyArray<RemoteAgentRecord>, preserveAll = false) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const fences = yield* sql<{
        project_id: string;
      }>`SELECT project_id FROM project_move_fences`.pipe(
        Effect.mapError(fail("read Project fences")),
      );
      const kept = preserveAll
        ? next
        : prune(next, DateTime.toEpochMillis(now), new Set(fences.map((row) => row.project_id)));
      yield* writeFileStringAtomically({
        filePath,
        contents: encodeStoreFile({ version: 1, agents: kept }),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(fail("write")),
      );
    });

  const list = lock.withPermits(1)(load.pipe(Effect.map((records) => [...records])));

  const loadForMove = Effect.gen(function* () {
    const unreadable = new RemoteAgentStoreError({
      detail: "Recover the unreadable linked-agent registry before moving a coordinator.",
    });
    if (yield* fileSystem.exists(`${filePath}.unreadable`).pipe(Effect.mapError(() => unreadable)))
      return yield* unreadable;
    const exists = yield* fileSystem.exists(filePath).pipe(Effect.mapError(() => unreadable));
    const records: RemoteAgentRecord[] = [];
    if (exists) {
      const raw = yield* fileSystem
        .readFileString(filePath)
        .pipe(Effect.mapError(() => unreadable));
      const decoded = decodeStoreFile(raw);
      if (Option.isNone(decoded)) return yield* unreadable;
      records.push(...decoded.value.agents);
    }
    return records;
  });
  const listForMove = lock.withPermits(1)(loadForMove);
  const checkRemoteClaim = (threadId: string, projectId: string) =>
    Effect.gen(function* () {
      const occupied =
        yield* sql`SELECT 1 FROM project_move_history_claims WHERE kind='thread' AND identity=${threadId}
      AND owner<>${"remote:" + projectId}`;
      if (occupied.length)
        return yield* new RemoteAgentStoreError({
          detail: "An agent thread identity is reserved for a Project move.",
        });
    });
  const replaceForMove: RemoteAgentStoreShape["replaceForMove"] = (
    projectId,
    moveId,
    agents,
    verifyOnly,
    localThreads = [],
  ) =>
    lock.withPermits(1)(
      registryWrite(
        Effect.gen(function* () {
          if ((yield* projectMoveFenceOwner(sql, projectId)) !== moveId)
            return yield* new RemoteAgentStoreError({
              detail: "The Project move fence is missing.",
            });
          const records = yield* loadForMove;
          const other = records.filter((record) => record.homeProjectId !== projectId);
          const localIds = new Set(localThreads);
          if (records.some((record) => localIds.has(record.threadId)))
            return yield* new RemoteAgentStoreError({
              detail: "A Project thread collides with a linked agent.",
            });
          const occupied = new Set(other.map((record) => record.threadId));
          for (const agent of agents) {
            yield* checkRemoteClaim(agent.threadId, projectId);
            if (agent.homeProjectId !== projectId || occupied.has(agent.threadId))
              return yield* new RemoteAgentStoreError({
                detail: "A linked agent identity collides on this machine.",
              });
            occupied.add(agent.threadId);
          }
          const next = [...other, ...agents];
          if (
            !verifyOnly &&
            encodeStoreFile({ version: 1, agents: records }) !==
              encodeStoreFile({ version: 1, agents: next })
          )
            yield* persist(next, true);
        }),
      ).pipe(
        Effect.mapError((cause) =>
          isRemoteAgentStoreError(cause) ? cause : fail("restore linked agents")(cause),
        ),
      ),
    );

  const get = (threadId: string) =>
    list.pipe(
      Effect.map((records) => Option.fromNullishOr(records.find((r) => r.threadId === threadId))),
    );

  const put = (record: RemoteAgentRecord) =>
    lock.withPermits(1)(
      registryWrite(
        Effect.gen(function* () {
          const records = yield* load;
          const previous = records.find((r) => r.threadId === record.threadId);
          if (previous && previous.homeProjectId !== record.homeProjectId)
            return yield* new RemoteAgentStoreError({
              detail: "The agent belongs to another Project.",
            });
          yield* withProjectWriter(
            sql,
            record.homeProjectId,
            sql.withTransaction(
              checkRemoteClaim(record.threadId, record.homeProjectId).pipe(
                Effect.andThen(
                  persist([...records.filter((r) => r.threadId !== record.threadId), record]),
                ),
              ),
            ),
            "file",
          ).pipe(Effect.mapError(fail("write agent")));
        }),
      ),
    );

  const update = (threadId: string, change: (record: RemoteAgentRecord) => RemoteAgentRecord) =>
    lock.withPermits(1)(
      registryWrite(
        Effect.gen(function* () {
          const records = yield* load;
          const current = records.find((r) => r.threadId === threadId);
          if (current === undefined) return Option.none<RemoteAgentRecord>();
          const next = change(current);
          if (threadId !== next.threadId || current.homeProjectId !== next.homeProjectId)
            return yield* new RemoteAgentStoreError({
              detail: "An agent update must preserve its thread and home Project.",
            });
          yield* withProjectWriter(
            sql,
            current.homeProjectId,
            persist(records.map((r) => (r.threadId === threadId ? next : r))),
            "file",
          ).pipe(Effect.mapError(fail("update agent")));
          return Option.some(next);
        }),
      ),
    );

  const remove = (threadId: string) =>
    lock.withPermits(1)(
      registryWrite(
        Effect.gen(function* () {
          const records = yield* load;
          const current = records.find((r) => r.threadId === threadId);
          if (!current) return;
          yield* withProjectWriter(
            sql,
            current.homeProjectId,
            persist(records.filter((r) => r.threadId !== threadId)),
            "file",
          ).pipe(Effect.mapError(fail("remove agent")));
        }),
      ),
    );

  return {
    list,
    listForMove,
    replaceForMove,
    get,
    put,
    update,
    remove,
  } satisfies RemoteAgentStoreShape;
});

export const RemoteAgentStoreLive = Layer.effect(RemoteAgentStore, make);
