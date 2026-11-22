/**
 * The calling side of cross-server reach: one op on a linked machine over the
 * linked-machine link (its token, identity pinning and URL rules). Tools on
 * this server use it to reach Projects or the Assistant on another server.
 * Fork-owned; see docs/internals/assistant-cross-server-reach.md.
 *
 * @module Reach
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { AgentMachines, type MachineHealth } from "../agentMachines/AgentMachines.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { noteSent, reachInputHash } from "./reachSent.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  DescribeResult,
  type OverviewProject,
  OverviewResult,
  ReachResponse,
  type ReachCaller,
  type ReachOp,
} from "./reachProtocol.ts";

export class ReachError extends Schema.TaggedError<ReachError>()("ReachError", {
  /**
   * `offline`: not reachable now. `timeout`: sent, no answer in time, it may
   * still finish. `relink`: token refused. `refused`: it answered with an error.
   */
  kind: Schema.Literals(["offline", "timeout", "relink", "refused"]),
  machineId: Schema.String,
  machineLabel: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface ReachMachine {
  readonly id: string;
  readonly label: string;
}

export interface RemoteAssistant {
  readonly machineId: string;
  readonly machineLabel: string;
  readonly threadId: string;
  readonly projectId: string;
}

export interface ReachShape {
  /** Every linked machine. */
  readonly machines: Effect.Effect<ReadonlyArray<ReachMachine>>;
  readonly healthOf: (machineId: string) => Effect.Effect<MachineHealth>;
  /** This server, as a caller: its environment id and label. */
  readonly self: Effect.Effect<{ readonly environmentId: string; readonly label: string }>;
  /** Runs one op on a linked machine and decodes its result. */
  readonly call: <A, I>(
    machine: ReachMachine,
    op: ReachOp,
    input: unknown,
    caller: { readonly threadId: string; readonly threadTitle: string },
    result: Schema.Codec<A, I>,
    options?: {
      readonly timeout?: Duration.Duration;
      /** Call even if the machine failed a moment ago (a confirmation must not reuse that). */
      readonly fresh?: boolean;
    },
  ) => Effect.Effect<A, ReachError>;
  /** The user's Assistant on a linked machine, cached for a minute. None when no machine has one. */
  readonly findAssistant: Effect.Effect<Option.Option<RemoteAssistant>>;
  /**
   * A machine's overview. On failure, the last one it gave (if any) comes
   * back with the error, so a sleeping machine still lists its Projects.
   */
  readonly overview: (
    machine: ReachMachine,
    caller: { readonly threadId: string; readonly threadTitle: string },
  ) => Effect.Effect<
    { readonly result: OverviewResult; readonly at: string },
    { readonly error: ReachError; readonly lastKnown: OverviewResult | null }
  >;
  /**
   * The linked machine that runs a Project, from the last overviews; asks
   * every machine again when it is not known. None when no machine has it.
   */
  readonly locateProject: (
    projectId: string,
    caller: { readonly threadId: string; readonly threadTitle: string },
  ) => Effect.Effect<
    Option.Option<{ readonly machine: ReachMachine; readonly project: OverviewProject }>
  >;
  /** The linked machine that has a thread, from the last overviews' coordinators and workspaces. */
  readonly locateThread: (threadId: string) => Effect.Effect<Option.Option<ReachMachine>>;
}

/** No linked machines: what tests and builds without the live layer see. */
export const unlinkedReach: ReachShape = {
  machines: Effect.succeed([]),
  healthOf: () => Effect.succeed({ status: "unknown", detail: null, lastSeenAt: null }),
  self: Effect.succeed({ environmentId: "", label: "" }),
  call: (machine) =>
    Effect.fail(
      new ReachError({
        kind: "offline",
        machineId: machine.id,
        machineLabel: machine.label,
        detail: `${machine.label} is not linked.`,
      }),
    ),
  findAssistant: Effect.succeedNone,
  overview: (machine) =>
    Effect.fail({
      error: new ReachError({
        kind: "offline",
        machineId: machine.id,
        machineLabel: machine.label,
        detail: `${machine.label} is not linked.`,
      }),
      lastKnown: null,
    }),
  locateProject: () => Effect.succeedNone,
  locateThread: () => Effect.succeedNone,
};

/** A reference, so code and tests that never link a machine need not provide it. */
export const Reach = Context.Reference<ReachShape>("t3/reach/Reach", {
  defaultValue: () => unlinkedReach,
});

const ASSISTANT_CACHE_MS = 60_000;

/** How a failure reads to an agent: names the machine and what to do. */
export function reachFailureDetail(
  machineLabel: string,
  kind: "offline" | "relink",
  lastSeenAt: string | null,
): string {
  if (kind === "relink") {
    return `${machineLabel} refused this machine's token. Link it again in Settings > Connections > Agent machines.`;
  }
  const seen = lastSeenAt === null ? "" : `, last seen ${lastSeenAt}`;
  return `${machineLabel} is offline${seen}. Nothing was sent; try again when it is awake.`;
}

const decodeResponse = Schema.decodeUnknownOption(ReachResponse);

const LastOverviewsJson = Schema.fromJsonString(Schema.Record(Schema.String, OverviewResult));
const encodeLastOverviews = Schema.encodeEffect(LastOverviewsJson);
const decodeLastOverviews = Schema.decodeUnknownEffect(LastOverviewsJson);

export const make = Effect.gen(function* () {
  const agentMachines = yield* AgentMachines;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  let assistantCache: { atMs: number; value: Option.Option<RemoteAssistant> } | null = null;
  // Each machine's last overview, kept across restarts so a sleeping machine's
  // Projects still show (as stale) after this server restarts.
  const overviewsPath = `${config.stateDir}/reach-overviews.json`;
  const lastOverview = new Map<string, OverviewResult>(
    Object.entries(
      yield* fileSystem.readFileString(overviewsPath).pipe(
        Effect.flatMap(decodeLastOverviews),
        Effect.orElseSucceed((): Record<string, OverviewResult> => ({})),
      ),
    ),
  );
  const saveOverviews = Effect.suspend(() =>
    encodeLastOverviews(Object.fromEntries(lastOverview)),
  ).pipe(
    Effect.flatMap((contents) => writeFileStringAtomically({ filePath: overviewsPath, contents })),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    Effect.ignore,
  );

  const self = Effect.gen(function* () {
    const descriptor = yield* environment.getDescriptor;
    return { environmentId: descriptor.environmentId as string, label: descriptor.label };
  });

  const call: ReachShape["call"] = (machine, op, input, caller, result, options) =>
    Effect.gen(function* () {
      const me = yield* self;
      const requestId = (yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "");
      noteSent(
        { requestId, op, inputHash: reachInputHash(input), receiver: machine.id },
        DateTime.toEpochMillis(yield* DateTime.now),
      );
      const body = {
        op,
        requestId,
        caller: {
          environmentId: me.environmentId,
          label: me.label,
          threadId: caller.threadId,
          threadTitle: caller.threadTitle,
        } satisfies ReachCaller,
        input,
      };
      const raw = yield* agentMachines.reach(machine.id, body, options).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            switch (error.kind) {
              case "unauthorized":
              case "unreachable": {
                const health = yield* agentMachines.healthOf(machine.id);
                const kind = error.kind === "unauthorized" ? "relink" : "offline";
                return yield* new ReachError({
                  kind,
                  machineId: machine.id,
                  machineLabel: machine.label,
                  detail: reachFailureDetail(machine.label, kind, health.lastSeenAt),
                });
              }
              case "timeout":
                return yield* new ReachError({
                  kind: "timeout",
                  machineId: machine.id,
                  machineLabel: machine.label,
                  detail: `${machine.label} did not answer in time. It may still finish what was asked.`,
                });
              default:
                // It answered: say what it said, never that it is offline.
                return yield* new ReachError({
                  kind: "refused",
                  machineId: machine.id,
                  machineLabel: machine.label,
                  detail: `${machine.label}: ${error.detail}`,
                });
            }
          }),
        ),
      );
      const response = decodeResponse(raw);
      const refused = (detail: string) =>
        new ReachError({
          kind: "refused",
          machineId: machine.id,
          machineLabel: machine.label,
          detail,
        });
      if (Option.isNone(response)) {
        return yield* refused(`${machine.label} sent an answer this machine cannot read.`);
      }
      if (!response.value.ok) return yield* refused(response.value.error);
      return yield* Schema.decodeUnknownEffect(result)(response.value.result).pipe(
        Effect.mapError(() => refused(`${machine.label} sent an answer this machine cannot read.`)),
      );
    });

  const findAssistant = Effect.gen(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (assistantCache !== null && nowMs - assistantCache.atMs < ASSISTANT_CACHE_MS) {
      return assistantCache.value;
    }
    const machines = yield* agentMachines.linked;
    let found: Option.Option<RemoteAssistant> = Option.none();
    let unanswered = 0;
    for (const machine of machines) {
      const described = yield* call(
        machine,
        "describe",
        {},
        { threadId: "", threadTitle: "" },
        DescribeResult,
      ).pipe(Effect.option);
      if (Option.isNone(described)) {
        unanswered += 1;
        continue;
      }
      const assistant = described.value.assistant;
      if (assistant !== null) {
        found = Option.some({
          machineId: machine.id,
          machineLabel: machine.label,
          threadId: assistant.threadId,
          projectId: assistant.projectId,
        });
        break;
      }
    }
    // Only a definite answer is cached: an offline machine is asked again next time.
    if (Option.isSome(found) || unanswered === 0) {
      assistantCache = { atMs: nowMs, value: found };
    }
    return found;
  });

  const overview: ReachShape["overview"] = (machine, caller) =>
    call(machine, "overview", {}, caller, OverviewResult).pipe(
      Effect.tap((result) =>
        Effect.suspend(() => {
          lastOverview.set(machine.id, result);
          return saveOverviews;
        }),
      ),
      Effect.flatMap((result) =>
        DateTime.now.pipe(Effect.map((now) => ({ result, at: DateTime.formatIso(now) }))),
      ),
      Effect.mapError((error) => ({ error, lastKnown: lastOverview.get(machine.id) ?? null })),
    );

  const knownMachineOf = (
    machines: ReadonlyArray<ReachMachine>,
    has: (result: OverviewResult) => boolean,
  ): Option.Option<ReachMachine> => {
    for (const machine of machines) {
      const known = lastOverview.get(machine.id);
      if (known !== undefined && has(known)) return Option.some(machine);
    }
    return Option.none();
  };

  const locateProject: ReachShape["locateProject"] = (projectId, caller) =>
    Effect.gen(function* () {
      const machines = yield* agentMachines.linked;
      const has = (result: OverviewResult) =>
        result.projects.some((project) => project.projectId === projectId);
      const withProject = (machine: Option.Option<ReachMachine>) =>
        Option.flatMap(machine, (found) =>
          Option.fromNullishOr(
            lastOverview.get(found.id)?.projects.find((project) => project.projectId === projectId),
          ).pipe(Option.map((project) => ({ machine: found, project }))),
        );
      const known = knownMachineOf(machines, has);
      if (Option.isSome(known)) return withProject(known);
      yield* Effect.forEach(machines, (machine) => Effect.ignore(overview(machine, caller)), {
        concurrency: 4,
        discard: true,
      });
      return withProject(knownMachineOf(machines, has));
    });

  const locateThread: ReachShape["locateThread"] = (threadId) =>
    agentMachines.linked.pipe(
      Effect.map((machines) =>
        knownMachineOf(
          machines,
          (result) =>
            result.projects.some((project) => project.coordinatorThreadId === threadId) ||
            result.workspaces.some((thread) => thread.threadId === threadId),
        ),
      ),
    );

  return {
    overview,
    locateProject,
    locateThread,
    machines: agentMachines.linked,
    healthOf: agentMachines.healthOf,
    self,
    call,
    findAssistant,
  } satisfies ReachShape;
});

export const ReachLive = Layer.effect(Reach, make);
