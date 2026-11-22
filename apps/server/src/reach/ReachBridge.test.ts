import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../config.ts";
import { AgentCompletionReactor } from "../orchestration/AgentCompletionReactor.ts";
import { agentPushId } from "../orchestration/agentProtocol.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { makeReachBridge, type ReachAskRecord } from "./ReachBridge.ts";
import type { ResultsResult } from "./reachProtocol.ts";
import { makeScriptedReach, type ScriptedMachine } from "./testReach.ts";

const CODEX = ProviderInstanceId.make("codex");
const AT = "2026-11-21T09:00:00.000Z";
const HOME = ProjectId.make("assistant-home");
const ASSISTANT = ThreadId.make("assistant");
const MESSAGE = "cp-send:ht-coord:ask:abc123def456:reach:r1";
const NOW = "2026-11-21T09:00:00.000Z";
/** Over a day before NOW. */
const LONG_AGO = "2026-11-20T08:00:00.000Z";

let answers: ResultsResult = { results: [], lost: [] };
const macbook: ScriptedMachine = {
  id: "env-macbook",
  label: "MacBook",
  online: true,
  answer: () => answers,
};
const scripted = makeScriptedReach([macbook]);
const enqueued: Array<string> = [];

const TestLayer = ProjectionThreadMessageRepositoryLive.pipe(
  Layer.provideMerge(scripted.layer),
  Layer.provideMerge(
    Layer.mock(AgentCompletionReactor)({
      enqueueProject: (projectId) => Effect.sync(() => void enqueued.push(projectId)),
    }),
  ),
  Layer.provideMerge(
    OrchestrationEngineLive.pipe(
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-reach-bridge-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

const dispatch = (command: OrchestrationCommand) =>
  Effect.flatMap(OrchestrationEngineService, (engine) => engine.dispatch(command));

const seed = Effect.gen(function* () {
  yield* dispatch({
    type: "project.create",
    commandId: CommandId.make("p"),
    projectId: HOME,
    title: "Assistant",
    workspaceRoot: "/tmp/home",
    createdAt: AT,
  });
  yield* dispatch({
    type: "thread.create",
    commandId: CommandId.make("t"),
    threadId: ASSISTANT,
    projectId: HOME,
    title: "Assistant",
    modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: AT,
  });
});

const record = (askedAt: string): ReachAskRecord => ({
  machineId: "env-macbook",
  machineLabel: "MacBook",
  coordinatorThreadId: "ht-coord",
  coordinatorTitle: "Hometrace",
  messageId: MESSAGE,
  replyTo: ASSISTANT,
  askedAt,
});

const assistantMessages = Effect.flatMap(ProjectionThreadMessageRepository, (repository) =>
  repository.listByThreadId({ threadId: ASSISTANT }),
);

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.sync(() => {
    answers = { results: [], lost: [] };
    macbook.online = true;
    enqueued.length = 0;
  }).pipe(Effect.andThen(seed), Effect.andThen(effect), Effect.provide(TestLayer));

describe("ReachBridge", () => {
  it.effect("appends a remote answer into the Assistant once, under the push id", () =>
    run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const bridge = yield* makeReachBridge;
        const now = NOW;
        yield* bridge.track(record(now));
        yield* bridge.pollOnce;
        expect(yield* assistantMessages).toEqual([]);
        expect(yield* bridge.open).toHaveLength(1);

        answers = {
          results: [
            {
              threadId: "ht-coord",
              messageId: MESSAGE,
              threadTitle: "Hometrace",
              text: 'Result from agent "Hometrace" (threadId ht-coord): finished\n\nNothing.',
            },
          ],
          lost: [],
        };
        yield* bridge.pollOnce;
        yield* bridge.track(record(now));
        yield* bridge.pollOnce;
        const messages = yield* assistantMessages;
        expect(messages.map((message) => message.messageId)).toEqual([
          agentPushId("ht-coord", MESSAGE),
        ]);
        expect(messages[0]?.source).toEqual({
          kind: "agent",
          threadId: "ht-coord",
          threadTitle: "Hometrace (on MacBook)",
        });
        expect(enqueued).toContain(HOME);
        expect(yield* bridge.open).toEqual([]);
      }),
    ),
  );

  it.effect("keeps waiting while the machine is offline, then gives up after a day", () =>
    run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const bridge = yield* makeReachBridge;
        macbook.online = false;
        yield* bridge.track(record(NOW));
        yield* bridge.pollOnce;
        expect(yield* bridge.open).toHaveLength(1);
        expect(yield* assistantMessages).toEqual([]);

        // A restarted bridge reads the same file and has no backoff yet.
        const fresh = yield* makeReachBridge;
        yield* fresh.track({ ...record(LONG_AGO), messageId: `${MESSAGE}-old` });
        yield* fresh.pollOnce;
        const messages = yield* assistantMessages;
        expect(messages.map((message) => message.messageId)).toEqual([
          `${agentPushId("ht-coord", `${MESSAGE}-old`)}:timeout`,
        ]);
        expect(messages[0]?.text).toContain("MacBook has not answered for a day");
      }),
    ),
  );

  it.effect("tells the Assistant when the coordinator is gone", () =>
    run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const bridge = yield* makeReachBridge;
        yield* bridge.track({ ...record(NOW), messageId: `${MESSAGE}-lost` });
        answers = { results: [], lost: [{ threadId: "ht-coord", messageId: `${MESSAGE}-lost` }] };
        yield* bridge.pollOnce;
        const messages = yield* assistantMessages;
        expect(messages.at(-1)?.text).toContain("That coordinator is gone on MacBook");
        expect(yield* bridge.open).toEqual([]);
      }),
    ),
  );
});
