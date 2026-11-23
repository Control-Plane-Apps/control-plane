/**
 * The journal of Assistant moves on this server, in `assistant-moves.json`
 * (atomic writes), so a move a crash or timeout interrupted is finished or
 * undone on the next pass instead of leaving two Assistants or none.
 *
 * - The source records `adopting` before it pauses its Assistant, then
 *   `committing`, then `done` or `rolled-back`. `abort-pending` means it
 *   resumed its own Assistant but still owes the target an abort.
 * - The target records `preparing` before it creates anything, `adopted`
 *   once the paused copy is complete, then `committed` or `aborted`. An
 *   `aborted` entry refuses a late adopt with the same id.
 * - A `reclaim` entry: the user took the Assistant back here while its home
 *   machine was unreachable; `yield-pending` keeps telling that machine to
 *   pause its copy until it answers.
 *
 * An unreadable journal fails every call (fail closed): rolling back without
 * knowing what the other machine did could leave two live Assistants.
 *
 * Fork-owned; see docs/internals/assistant-cross-server-reach.md.
 *
 * @module assistantMoves
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";

export const SourcePhase = Schema.Literals([
  "adopting",
  "committing",
  "abort-pending",
  "done",
  "rolled-back",
]);
export const TargetPhase = Schema.Literals(["preparing", "adopted", "committed", "aborted"]);
export const ReclaimPhase = Schema.Literals(["yield-pending", "done"]);

export const MoveRecord = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("source"),
    moveId: Schema.String,
    peerId: Schema.String,
    peerLabel: Schema.String,
    phase: SourcePhase,
    projectId: Schema.String,
    threadId: Schema.String,
    startedAt: Schema.String,
  }),
  Schema.Struct({
    role: Schema.Literal("target"),
    moveId: Schema.String,
    peerId: Schema.String,
    peerLabel: Schema.String,
    phase: TargetPhase,
    projectId: Schema.String,
    threadId: Schema.String,
    /** The project was made for this move (deleted on abort), not an archived one reused. */
    created: Schema.Boolean,
    /** Reusing an archived Assistant: its coordinator before this move gave it a fresh thread. */
    previousThreadId: Schema.optional(Schema.String),
    /** After commit: the previous coordinator was archived (or found gone); not tried again. */
    previousRetired: Schema.optional(Schema.Boolean),
    /** What adopting overwrote, put back on abort. */
    previousSettings: Schema.Unknown,
    previousMemory: Schema.NullOr(Schema.String),
    /** Open asks, tracked once the move commits. */
    asks: Schema.Unknown,
    startedAt: Schema.String,
  }),
  Schema.Struct({
    role: Schema.Literal("reclaim"),
    moveId: Schema.String,
    /** The machine that ran the Assistant and must pause its copy. */
    peerId: Schema.String,
    peerLabel: Schema.String,
    phase: ReclaimPhase,
    startedAt: Schema.String,
  }),
]);
export type MoveRecord = typeof MoveRecord.Type;
export type SourceMove = Extract<MoveRecord, { role: "source" }>;
export type TargetMove = Extract<MoveRecord, { role: "target" }>;
export type ReclaimMove = Extract<MoveRecord, { role: "reclaim" }>;

/** The journal exists but cannot be read or parsed. */
export class MoveJournalUnreadable extends Data.TaggedError("MoveJournalUnreadable")<{
  readonly detail: string;
}> {}

const FileJson = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), moves: Schema.Array(MoveRecord) }),
);
const decodeFile = Schema.decodeUnknownOption(FileJson);
const encodeFile = Schema.encodeEffect(FileJson);

/** Finished moves kept this long, so a late retry or adopt with the same id is still recognized. */
const KEEP_FINISHED = 200;

export const makeMoveJournal = (stateDir: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = `${stateDir}/assistant-moves.json`;
    const lock = yield* Semaphore.make(1);
    let cache: Array<MoveRecord> | null = null;

    const load = Effect.gen(function* () {
      if (cache !== null) return cache;
      const unreadable = new MoveJournalUnreadable({
        detail: `The Assistant move journal (${filePath}) cannot be read, so no move is finished or undone until it is fixed or removed.`,
      });
      const exists = yield* fileSystem.exists(filePath).pipe(Effect.mapError(() => unreadable));
      if (!exists) {
        cache = [];
        return cache;
      }
      const raw = yield* fileSystem
        .readFileString(filePath)
        .pipe(Effect.mapError(() => unreadable));
      if (raw.trim().length === 0) {
        cache = [];
        return cache;
      }
      const decoded = decodeFile(raw);
      if (Option.isNone(decoded)) return yield* unreadable;
      cache = [...decoded.value.moves];
      return cache;
    });

    const persist = (moves: ReadonlyArray<MoveRecord>) =>
      encodeFile({ version: 1, moves: moves.slice(-KEEP_FINISHED) }).pipe(
        Effect.flatMap((contents) => writeFileStringAtomically({ filePath, contents })),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.tap(() => Effect.sync(() => void (cache = moves.slice(-KEEP_FINISHED)))),
        Effect.orDie,
      );

    const list = lock.withPermits(1)(load.pipe(Effect.map((moves) => [...moves])));

    const get = (moveId: string, role: MoveRecord["role"]) =>
      list.pipe(
        Effect.map((moves) =>
          Option.fromNullishOr(moves.find((move) => move.moveId === moveId && move.role === role)),
        ),
      );

    /** Inserts or replaces the record with this id and role. */
    const put = (record: MoveRecord) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const moves = yield* load;
          yield* persist([
            ...moves.filter(
              (move) => !(move.moveId === record.moveId && move.role === record.role),
            ),
            record,
          ]);
        }),
      );

    const getTarget = (moveId: string) =>
      get(moveId, "target").pipe(
        Effect.map(Option.filter((move): move is TargetMove => move.role === "target")),
      );

    const getReclaim = (moveId: string) =>
      get(moveId, "reclaim").pipe(
        Effect.map(Option.filter((move): move is ReclaimMove => move.role === "reclaim")),
      );

    return { list, get, getTarget, getReclaim, put };
  });

export type MoveJournal = Effect.Success<ReturnType<typeof makeMoveJournal>>;
