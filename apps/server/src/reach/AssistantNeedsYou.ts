import {
  AssistantNeedsYouError,
  AssistantNeedsYouReplyResult,
  EnvironmentId,
  findGlobalAssistantProject,
  isProjectInAssistantReach,
  isStatusNeedingUser,
  ProjectId,
  ProjectStatus,
  ThreadId,
  type AssistantNeedsYouEntry,
  type AssistantNeedsYouMachine,
  type AssistantNeedsYouReplyInput,
  type AssistantNeedsYouResult,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Path from "effect/Path";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { StatusListResult } from "../mcp/toolkits/agents/tools.ts";
import { Reach, type ReachMachine } from "./Reach.ts";
import type { ReachCaller } from "./reachProtocol.ts";
import { makeStatusQuestionReply } from "./statusQuestionReply.ts";

// Opaque tuple keys keep machine and Project boundaries unambiguous.
const scopedKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export interface AssistantNeedsYouShape {
  readonly read: Effect.Effect<AssistantNeedsYouResult, AssistantNeedsYouError>;
  readonly reply: (
    input: AssistantNeedsYouReplyInput,
  ) => Effect.Effect<{ readonly queued: boolean }, AssistantNeedsYouError>;
}

const unavailable = Effect.fail(
  new AssistantNeedsYouError({
    detail: "Update the Assistant server to read or answer questions across machines.",
  }),
);
export const AssistantNeedsYou = Context.Reference<AssistantNeedsYouShape>(
  "t3/reach/AssistantNeedsYou",
  {
    defaultValue: () => ({ read: unavailable, reply: () => unavailable }),
  },
);

function isLiveProject(project: OrchestrationProjectShell) {
  return (
    project.assistant != null &&
    project.assistant.archivedAt == null &&
    project.assistant.scope !== "global"
  );
}

export function sortNeedsYou(items: ReadonlyArray<AssistantNeedsYouEntry>) {
  return [...items].sort((a, b) => {
    const left = a.status.decision.deadline;
    const right = b.status.decision.deadline;
    if (left !== undefined && right !== undefined && left !== right)
      return left.localeCompare(right);
    if (left !== undefined && right === undefined) return -1;
    if (right !== undefined && left === undefined) return 1;
    return (
      b.status.decision.openedAt.localeCompare(a.status.decision.openedAt) ||
      scopedKey([a.environmentId, a.projectId, a.status.id]).localeCompare(
        scopedKey([b.environmentId, b.projectId, b.status.id]),
      )
    );
  });
}

const PEER_CACHE_MS = 5_000;
const LEGACY_HYDRATION_BUDGET_MS = 2_000;
const LegacyBoard = Schema.Struct({
  environmentId: Schema.String,
  projectId: Schema.String,
  coordinatorThreadId: Schema.String,
  statuses: Schema.Array(ProjectStatus),
});
const LegacyBoardsJson = Schema.fromJsonString(Schema.Array(LegacyBoard));
const legacyBoardKey = (board: Omit<typeof LegacyBoard.Type, "statuses">) =>
  scopedKey([board.environmentId, board.projectId, board.coordinatorThreadId]);
interface PeerRead {
  readonly entries: ReadonlyArray<{
    readonly source: Omit<AssistantNeedsYouEntry, "status">;
    readonly statuses: ReadonlyArray<ProjectStatus>;
  }>;
  readonly machine: AssistantNeedsYouMachine;
}
interface PeerCache {
  generation: number;
  value?: { readonly result: PeerRead; readonly at: number };
  pending?: { readonly result: Deferred.Deferred<PeerRead>; readonly generation: number };
}

export const make = Effect.gen(function* () {
  const reach = yield* Reach;
  const snapshots = yield* ProjectionSnapshotQuery;
  const settings = yield* ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const replyLocally = yield* makeStatusQuestionReply;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const scope = yield* Scope.Scope;
  const peerSlots = yield* Semaphore.make(4);
  const writeSlot = yield* Semaphore.make(1);
  const boardsPath = path.join(config.stateDir, "assistant-needs-you-boards.json");
  // Older overviews omit question revisions. Keep only boards actually read from
  // status.list, so restarts can display known stale questions without inventing one.
  const legacyBoards = new Map(
    (yield* fileSystem.readFileString(boardsPath).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(LegacyBoardsJson)),
      Effect.orElseSucceed((): ReadonlyArray<typeof LegacyBoard.Type> => []),
    )).map((board) => [legacyBoardKey(board), board]),
  );
  const saveBoards = writeSlot.withPermits(1)(
    Effect.suspend(() => Schema.encodeEffect(LegacyBoardsJson)([...legacyBoards.values()])).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: boardsPath, contents })),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.ignore,
    ),
  );
  const peerReads = new Map<string, PeerCache>();
  const context = Effect.gen(function* () {
    const snapshot = yield* snapshots
      .getShellSnapshot()
      .pipe(
        Effect.mapError(
          () => new AssistantNeedsYouError({ detail: "Could not read the Assistant's Projects." }),
        ),
      );
    const home = findGlobalAssistantProject(snapshot.projects);
    if (home?.assistant == null)
      return yield* new AssistantNeedsYouError({
        detail: "This machine does not run the Assistant. Reopen the Assistant and try again.",
      });
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(
        () =>
          new AssistantNeedsYouError({ detail: "Could not read the Assistant's reach settings." }),
      ),
    );
    return {
      snapshot,
      settings: current.assistant,
      caller: { threadId: home.assistant.coordinatorThreadId, threadTitle: "Assistant" },
    };
  });
  const readPeer = (machine: ReachMachine, caller: Pick<ReachCaller, "threadId" | "threadTitle">) =>
    Effect.gen(function* () {
      const overview = yield* reach.overview(machine, caller).pipe(
        Effect.map(({ result }) => ({
          result,
          stale: false,
          problem: undefined as string | undefined,
        })),
        Effect.catch(({ error, lastKnown }) =>
          Effect.succeed({ result: lastKnown, stale: true, problem: error.detail }),
        ),
      );
      const entries: Array<{
        source: Omit<AssistantNeedsYouEntry, "status">;
        statuses: ReadonlyArray<ProjectStatus>;
      }> = [];
      let problem = overview.problem;
      let snapshotSequence = overview.result?.snapshotSequence;
      let hydrationFailed = false;
      let boardsChanged = false;
      const hydrationDeadline = (yield* Clock.currentTimeMillis) + LEGACY_HYDRATION_BUDGET_MS;
      if (!overview.stale) {
        const liveBoards = new Set(
          (overview.result?.projects ?? []).map((project) =>
            legacyBoardKey({
              environmentId: machine.id,
              projectId: project.projectId,
              coordinatorThreadId: project.coordinatorThreadId,
            }),
          ),
        );
        for (const [key, board] of legacyBoards) {
          if (board.environmentId === machine.id && !liveBoards.has(key)) {
            legacyBoards.delete(key);
            boardsChanged = true;
          }
        }
      }
      for (const project of overview.result?.projects ?? []) {
        let projectStale = overview.stale;
        let statuses: ReadonlyArray<ProjectStatus> = project.needsYou.flatMap((entry) =>
          entry.status === undefined ? [] : [entry.status],
        );
        // Older peers already expose full boards through status.list. Do not invent a question revision.
        if (project.needsYou.some((entry) => entry.status === undefined)) {
          // A separately fetched legacy board may be newer than this overview's version.
          snapshotSequence = undefined;
          const board = {
            environmentId: machine.id,
            projectId: project.projectId,
            coordinatorThreadId: project.coordinatorThreadId,
          };
          const boardKey = legacyBoardKey(board);
          statuses = legacyBoards.get(boardKey)?.statuses ?? statuses;
          const remaining = hydrationDeadline - (yield* Clock.currentTimeMillis);
          if (overview.stale || hydrationFailed || remaining <= 0) {
            projectStale = true;
            problem ??=
              "Showing last known questions. Some question revisions could not be checked.";
          } else {
            const failure =
              "Question details did not answer within the peer read budget. Showing last known questions.";
            const result = yield* reach
              .call(
                machine,
                "status.list",
                { projectId: project.projectId },
                caller,
                StatusListResult,
                {
                  timeout: Duration.millis(remaining),
                },
              )
              .pipe(
                Effect.map((result) => ({
                  statuses: result.statuses,
                  error: undefined as string | undefined,
                })),
                Effect.catch((error) => Effect.succeed({ statuses, error: error.detail })),
                Effect.timeoutOrElse({
                  duration: Duration.millis(remaining),
                  orElse: () => Effect.succeed({ statuses, error: failure }),
                }),
              );
            statuses = result.statuses;
            if (result.error === undefined) {
              legacyBoards.set(boardKey, { ...board, statuses });
              boardsChanged = true;
            } else {
              hydrationFailed = true;
              problem = result.error;
              projectStale = true;
            }
          }
        }
        entries.push({
          source: {
            environmentId: EnvironmentId.make(machine.id),
            machineLabel: machine.label,
            projectId: ProjectId.make(project.projectId),
            projectTitle: project.title,
            coordinatorThreadId: ThreadId.make(project.coordinatorThreadId),
            stale: projectStale,
          },
          statuses,
        });
      }
      if (boardsChanged) yield* saveBoards;
      return {
        entries,
        machine: {
          environmentId: EnvironmentId.make(machine.id),
          label: machine.label,
          ...(snapshotSequence === undefined ? {} : { snapshotSequence }),
          state: overview.stale
            ? ("offline" as const)
            : problem === undefined
              ? ("online" as const)
              : ("error" as const),
          ...(problem === undefined ? {} : { detail: problem }),
        },
      };
    });
  const readPeerCached = (
    machine: ReachMachine,
    caller: Pick<ReachCaller, "threadId" | "threadTitle">,
  ): Effect.Effect<PeerRead> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        let cached = peerReads.get(machine.id);
        if (cached === undefined) {
          cached = { generation: 0 };
          peerReads.set(machine.id, cached);
        }
        if (cached.pending !== undefined) {
          const pending = cached.pending;
          const result = yield* restore(Deferred.await(pending.result));
          return pending.generation === cached.generation
            ? result
            : yield* restore(readPeerCached(machine, caller));
        }
        const now = yield* Clock.currentTimeMillis;
        if (cached.value !== undefined && now - cached.value.at < PEER_CACHE_MS)
          return cached.value.result;
        const pending = {
          result: yield* Deferred.make<PeerRead>(),
          generation: cached.generation,
        };
        cached.pending = pending;
        const entry = cached;
        // The service owns this bounded flight. A cancelled RPC stops waiting,
        // rather than cancelling the peer call that other readers share.
        yield* peerSlots
          .withPermits(1)(readPeer(machine, caller))
          .pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                delete entry.pending;
                if (Exit.isSuccess(exit) && pending.generation === entry.generation)
                  entry.value = { result: exit.value, at: yield* Clock.currentTimeMillis };
                yield* Deferred.done(pending.result, exit);
              }),
            ),
            Effect.interruptible,
            Effect.forkIn(scope),
          );
        const result = yield* restore(Deferred.await(pending.result));
        return pending.generation === entry.generation
          ? result
          : yield* restore(readPeerCached(machine, caller));
      }),
    );
  const read = Effect.gen(function* () {
    const current = yield* context;
    const self = yield* environment.getDescriptor;
    const items: AssistantNeedsYouEntry[] = [];
    const machines: AssistantNeedsYouMachine[] = [
      {
        environmentId: self.environmentId,
        label: self.label,
        snapshotSequence: current.snapshot.snapshotSequence,
        state: "online",
      },
    ];
    const seen = new Set<string>();
    const add = (
      source: Omit<AssistantNeedsYouEntry, "status">,
      statuses: ReadonlyArray<ProjectStatus>,
    ) => {
      for (const status of statuses) {
        if (status.decision === undefined || !isStatusNeedingUser(status)) continue;
        const key = scopedKey([source.environmentId, source.projectId, status.id]);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ ...source, status: { ...status, decision: status.decision } });
      }
    };
    for (const project of current.snapshot.projects) {
      if (!isLiveProject(project) || !isProjectInAssistantReach(current.settings, project.id))
        continue;
      add(
        {
          environmentId: self.environmentId,
          machineLabel: self.label,
          projectId: project.id,
          projectTitle: project.title,
          coordinatorThreadId: project.assistant!.coordinatorThreadId,
          stale: false,
        },
        project.assistant!.statuses ?? [],
      );
    }
    const linked = [
      ...new Map((yield* reach.machines).map((machine) => [machine.id, machine])).values(),
    ].filter((machine) => machine.id !== self.environmentId);
    const linkedIds = new Set(linked.map((machine) => machine.id));
    for (const [id, cached] of peerReads) {
      if (!linkedIds.has(id) && cached.pending === undefined) peerReads.delete(id);
    }
    let prunedBoards = false;
    for (const [key, board] of legacyBoards) {
      if (!linkedIds.has(board.environmentId)) {
        legacyBoards.delete(key);
        prunedBoards = true;
      }
    }
    if (prunedBoards) yield* saveBoards;
    const remote = yield* Effect.forEach(
      linked,
      (machine) => readPeerCached(machine, current.caller),
      {
        concurrency: 4,
      },
    );
    for (const result of remote) {
      machines.push(result.machine);
      for (const entry of result.entries) {
        if (isProjectInAssistantReach(current.settings, entry.source.projectId))
          add(entry.source, entry.statuses);
      }
    }
    return { items: sortNeedsYou(items), machines };
  });
  const reply: AssistantNeedsYouShape["reply"] = (input) =>
    Effect.gen(function* () {
      const current = yield* context;
      if (!isProjectInAssistantReach(current.settings, input.projectId))
        return yield* new AssistantNeedsYouError({
          detail: "This Project is outside the Assistant's reach.",
        });
      const self = yield* environment.getEnvironmentId;
      if (input.environmentId === self) return yield* replyLocally(input);
      const machine = (yield* reach.machines).find((entry) => entry.id === input.environmentId);
      if (machine === undefined)
        return yield* new AssistantNeedsYouError({
          detail: "This machine is no longer linked to the Assistant.",
        });
      // The callee validates its own environment, live Project, coordinator, question and revision atomically with the append.
      return yield* reach
        .call(machine, "status.reply", input, current.caller, AssistantNeedsYouReplyResult, {
          fresh: true,
        })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              const cached = peerReads.get(machine.id);
              if (cached !== undefined) {
                cached.generation += 1;
                delete cached.value;
              }
            }),
          ),
          Effect.mapError(
            (error) =>
              new AssistantNeedsYouError({
                detail: `${error.detail} The answer was not confirmed; refresh before trying again.`,
              }),
          ),
        );
    });
  return { read, reply } satisfies AssistantNeedsYouShape;
});

export const AssistantNeedsYouLive = Layer.effect(AssistantNeedsYou, make).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
);
