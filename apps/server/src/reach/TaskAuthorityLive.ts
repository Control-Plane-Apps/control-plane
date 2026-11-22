/**
 * Keeps `taskAuthority` current: at build (before clients connect) from this
 * server's own Projects and the stored answers of linked machines, then every
 * few minutes from fresh `describe` calls. A machine that does not answer
 * keeps its stored answer, so a sleeping Assistant host stays the authority.
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
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { Reach } from "./Reach.ts";
import { DescribeResult } from "./reachProtocol.ts";
import {
  type AssistantAnswer,
  decideTaskAuthority,
  hostsAssistant,
  setTaskAuthority,
  type TaskAuthorityDecision,
} from "./taskAuthority.ts";

export const TASK_AUTHORITY_REFRESH = Duration.minutes(5);

const KnownJson = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Struct({ hosts: Schema.Boolean, at: Schema.Number })),
);
const decodeKnown = Schema.decodeUnknownEffect(KnownJson);
const encodeKnown = Schema.encodeEffect(KnownJson);

const describe = (decision: TaskAuthorityDecision) =>
  decision.authority
    ? "this server is the task authority"
    : `tasks defer to ${decision.deferTo.label}, which hosts the Assistant`;

export const TaskAuthorityLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const reach = yield* Reach;
    const snapshots = yield* ProjectionSnapshotQuery;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const filePath = `${config.stateDir}/reach-assistants.json`;
    const known = new Map<string, AssistantAnswer>(
      Object.entries(
        yield* fileSystem.readFileString(filePath).pipe(
          Effect.flatMap(decodeKnown),
          Effect.orElseSucceed((): Record<string, AssistantAnswer> => ({})),
        ),
      ),
    );
    let last: string | null = null;

    const recompute = Effect.gen(function* () {
      const selfId = yield* environment.getEnvironmentId;
      const snapshot = yield* snapshots.getShellSnapshot().pipe(Effect.option);
      const localAssistant =
        snapshot._tag === "Some" &&
        findGlobalAssistantProject(snapshot.value.projects) !== undefined;
      const machines = yield* reach.machines;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const decision = decideTaskAuthority({
        selfId,
        localAssistant,
        linked: machines.map((machine) => ({
          ...machine,
          hasAssistant: hostsAssistant(known.get(machine.id), nowMs),
        })),
      });
      setTaskAuthority(decision);
      const text = describe(decision);
      if (text !== last) {
        last = text;
        yield* Effect.logInfo(`task authority: ${text}`);
      }
    });

    const refresh = Effect.gen(function* () {
      for (const machine of yield* reach.machines) {
        const described = yield* reach
          .call(machine, "describe", {}, { threadId: "", threadTitle: "" }, DescribeResult)
          .pipe(Effect.option);
        if (described._tag === "Some") {
          known.set(machine.id, {
            hosts: described.value.assistant !== null,
            at: DateTime.toEpochMillis(yield* DateTime.now),
          });
        }
      }
      yield* encodeKnown(Object.fromEntries(known)).pipe(
        Effect.flatMap((contents) => writeFileStringAtomically({ filePath, contents })),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.ignore,
      );
      yield* recompute;
    });

    // Before clients connect, from what is stored; then keep it fresh.
    yield* recompute;
    yield* forkParked(
      Effect.gen(function* () {
        while (true) {
          yield* refresh.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("task authority refresh failed", { cause: String(cause) }),
            ),
          );
          yield* Effect.sleep(TASK_AUTHORITY_REFRESH);
        }
      }),
    );
  }),
);
