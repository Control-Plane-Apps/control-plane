import {
  ASSISTANT_ASK_ACTIVITY_KIND,
  assistantAskIdOf,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../../config.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadActivityRepository } from "../../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "../../../persistence/Services/ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AssistantToolkitHandlers } from "./handlers.ts";
import { AssistantAskResult, AssistantOverviewResult, AssistantToolkit } from "./tools.ts";

const CODEX = ProviderInstanceId.make("codex");
const AT = "2026-11-13T09:00:00.000Z";
const ACME = ProjectId.make("acme");
const OTHER = ProjectId.make("other");
const HOME = ProjectId.make("assistant-home");
const ACME_COORD = ThreadId.make("acme-coord");
const OTHER_COORD = ThreadId.make("other-coord");
const ASSISTANT = ThreadId.make("assistant");

let settings = DEFAULT_SERVER_SETTINGS;

const TestLayer = Layer.mergeAll(
  AssistantToolkitHandlers,
  ProjectionThreadMessageRepositoryLive,
  ProjectionThreadActivityRepositoryLive,
).pipe(
  Layer.provideMerge(
    Layer.mock(ServerSettingsService)({ getSettings: Effect.sync(() => settings) }),
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
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-assistant-tools-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

let counter = 0;
const cid = () => CommandId.make(`c-${(counter += 1)}`);
const dispatch = (command: OrchestrationCommand) =>
  Effect.flatMap(OrchestrationEngineService, (engine) => engine.dispatch(command));

const seed = Effect.gen(function* () {
  for (const [projectId, coord, title, scope] of [
    [ACME, ACME_COORD, "Acme", undefined],
    [OTHER, OTHER_COORD, "Other", undefined],
    [HOME, ASSISTANT, "Assistant", "global"],
  ] as const) {
    yield* dispatch({
      type: "project.create",
      commandId: cid(),
      projectId,
      title,
      workspaceRoot: `/tmp/${projectId}`,
      createdAt: AT,
    });
    yield* dispatch({
      type: "thread.create",
      commandId: cid(),
      threadId: coord,
      projectId,
      title,
      modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: AT,
    });
    yield* dispatch({
      type: "project.meta.update",
      commandId: cid(),
      projectId,
      assistant: { coordinatorThreadId: coord, ...(scope ? { scope } : {}) },
    });
  }
  yield* dispatch({
    type: "project.status.set",
    commandId: cid(),
    projectId: ACME,
    actorThreadId: ACME_COORD,
    change: {
      kind: "upsert",
      id: "payouts",
      title: "Payouts",
      state: "needs-you",
      summary: "Waiting on you",
      question: "Pay out weekly?",
      recommendation: "Pay out weekly.",
      answer: "Weekly",
    },
    createdAt: AT,
  });
});

const invocation = (caller: ThreadId) => ({
  environmentId: EnvironmentId.make("env"),
  threadId: caller,
  providerSessionId: "s",
  providerInstanceId: CODEX,
  capabilities: new Set<McpInvocationContext.McpCapability>(["agents"]),
  issuedAt: 1,
});

const lastResult = <S extends Schema.ConstraintDecoder<unknown>, E, R>(
  handled: Effect.Effect<Stream.Stream<{ readonly result: unknown }, E, R>, E, R>,
  success: S,
  caller: ThreadId,
) =>
  handled.pipe(
    Stream.unwrap,
    Stream.runCollect,
    Effect.map((chunk) => Schema.decodeUnknownSync(success)(chunk.at(-1)!.result)),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(caller)),
  );

const overview = (caller: ThreadId) =>
  Effect.flatMap(AssistantToolkit, (toolkit) =>
    lastResult(toolkit.handle("cp_assistant_overview", {}), AssistantOverviewResult, caller),
  );

const ask = (caller: ThreadId, question: string) =>
  Effect.flatMap(AssistantToolkit, (toolkit) =>
    lastResult(toolkit.handle("cp_assistant_ask", { question }), AssistantAskResult, caller),
  );

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  seed.pipe(Effect.andThen(effect), Effect.provide(TestLayer));

describe("cp_assistant_*", () => {
  it.effect("overview lists every Project's open questions, never the Assistant's own", () =>
    run(
      Effect.gen(function* () {
        settings = DEFAULT_SERVER_SETTINGS;
        const result = yield* overview(ASSISTANT);
        expect(result.projects.map((project) => project.title)).toEqual(["Acme", "Other"]);
        expect(result.projects[0]?.needsYou.map((question) => question.question)).toEqual([
          "Pay out weekly?",
        ]);
      }),
    ),
  );

  it.effect("ask holds one request per coordinator in reach and records the ask", () =>
    run(
      Effect.gen(function* () {
        settings = {
          ...DEFAULT_SERVER_SETTINGS,
          assistant: { ...DEFAULT_SERVER_SETTINGS.assistant, projects: [ACME] },
        };
        const result = yield* ask(ASSISTANT, "What shipped?");
        expect(result.asked.map((target) => target.projectId)).toEqual([ACME]);
        const messages = yield* (yield* ProjectionThreadMessageRepository).listByThreadId({
          threadId: ACME_COORD,
        });
        const request = messages.find((message) => assistantAskIdOf(message.messageId) !== null);
        expect(assistantAskIdOf(request!.messageId)).toBe(result.askId);
        expect(request?.source?.replyTo).toBe(ASSISTANT);
        const activities = yield* (yield* ProjectionThreadActivityRepository).listByThreadId({
          threadId: ASSISTANT,
        });
        expect(activities.some((activity) => activity.kind === ASSISTANT_ASK_ACTIVITY_KIND)).toBe(
          true,
        );
      }),
    ),
  );

  it.effect("refuses every caller but the Assistant", () =>
    run(
      Effect.gen(function* () {
        settings = DEFAULT_SERVER_SETTINGS;
        const outcome = yield* Effect.exit(overview(ACME_COORD));
        expect(outcome._tag).toBe("Failure");
      }),
    ),
  );
});
