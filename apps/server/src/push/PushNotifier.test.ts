import { RemoteAgentsLocalOnly } from "../agentMachines/testFixtures.ts";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  recommendationReplyText,
  statusAnswerMessageId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { issuePushActionToken, PUSH_ACTION_SIGNING_SECRET } from "./actionToken.ts";
import {
  assistantPingFromPayload,
  layer as pushNotifierLayer,
  PushNotifier,
  questionToSend,
  sessionOutcome,
} from "./PushNotifier.ts";

const PROJECT_ID = ProjectId.make("project-acme");
const COORDINATOR = ThreadId.make("thread-coordinator");
const CODEX = ProviderInstanceId.make("codex");
const SEEDED_AT = "2026-01-01T00:00:00.000Z";
const NOW = "2026-11-13T12:00:00.000Z";

const TestLayer = Layer.mergeAll(
  pushNotifierLayer.pipe(Layer.provide(ServerSecretStore.layer)),
  ServerSecretStore.layer,
  ProjectionThreadMessageRepositoryLive,
).pipe(
  Layer.provideMerge(
    Layer.mock(ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
    }),
  ),
  Layer.provideMerge(makeProviderRegistryLayer()),
  Layer.provideMerge(RemoteAgentsLocalOnly),
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
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-push-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

let counter = 0;
const nextCommandId = () => CommandId.make(`push-test-${(counter += 1)}`);
const dispatch = (command: OrchestrationCommand) =>
  Effect.flatMap(OrchestrationEngineService, (engine) => engine.dispatch(command));

const seed = Effect.gen(function* () {
  yield* dispatch({
    type: "project.create",
    commandId: nextCommandId(),
    projectId: PROJECT_ID,
    title: "Hometrace",
    workspaceRoot: "/tmp/hometrace",
    createdAt: SEEDED_AT,
  });
  yield* dispatch({
    type: "thread.create",
    commandId: nextCommandId(),
    threadId: COORDINATOR,
    projectId: PROJECT_ID,
    title: "Hometrace",
    modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: SEEDED_AT,
  });
  yield* dispatch({
    type: "project.meta.update",
    commandId: nextCommandId(),
    projectId: PROJECT_ID,
    assistant: { coordinatorThreadId: COORDINATOR },
  });
});

const setQuestion = (recommendation: string, answer: string, createdAt = NOW) =>
  dispatch({
    type: "project.status.set",
    commandId: nextCommandId(),
    projectId: PROJECT_ID,
    actorThreadId: COORDINATOR,
    change: {
      kind: "upsert",
      id: "payments-retry",
      title: "Payments retry",
      summary: "Retries wired.",
      question: "Retry declined cards 3 times over 5 days?",
      recommendation,
      answer,
    },
    createdAt,
  });

const currentDecision = Effect.gen(function* () {
  const project = yield* (yield* ProjectionSnapshotQuery).getProjectShellById(PROJECT_ID);
  if (project._tag === "None") throw new Error("no project");
  const status = project.value.assistant?.statuses?.find((entry) => entry.id === "payments-retry");
  if (status?.decision === undefined) throw new Error("no decision");
  return { status, decision: status.decision };
});

const tokenFor = (openedAt: string) =>
  Effect.gen(function* () {
    const secret = yield* (yield* ServerSecretStore.ServerSecretStore).getOrCreateRandom(
      PUSH_ACTION_SIGNING_SECRET,
      32,
    );
    return issuePushActionToken(
      {
        kind: "push-status-answer",
        projectId: PROJECT_ID,
        statusId: "payments-retry",
        openedAt,
      },
      secret,
      Date.parse(NOW),
    );
  });

const coordinatorTexts = Effect.flatMap(ProjectionThreadMessageRepository, (messages) =>
  messages.listByThreadId({ threadId: COORDINATOR }),
).pipe(Effect.map((rows) => rows.map((row) => row.text)));

const withEngine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.setTime(Date.parse(NOW)).pipe(
    Effect.andThen(seed),
    Effect.andThen(effect),
    Effect.provide(TestLayer),
  );

describe("answering a Status question from an iPhone notification", () => {
  it.effect("sends exactly what the Status panel's answer sends, and marks it answered", () =>
    withEngine(
      Effect.gen(function* () {
        yield* setQuestion("Retry 3 times over 5 days", "Retry 3 times");
        const { status, decision } = yield* currentDecision;
        const notifier = yield* PushNotifier;
        const outcome = yield* notifier.runAction(yield* tokenFor(decision.openedAt), "answer");
        expect(outcome).toEqual({ ok: true });
        expect(yield* coordinatorTexts).toContain(recommendationReplyText(status, decision));
        expect((yield* currentDecision).decision.answeredAt).toBeDefined();
        // A second tap, here or on another phone, sends nothing new.
        const again = yield* notifier.runAction(yield* tokenFor(decision.openedAt), "answer");
        expect(again).toEqual({ ok: false, status: 409, refusal: "answered" });
      }),
    ),
  );

  it.effect("refuses an answer to an outdated version of the question, sending nothing", () =>
    withEngine(
      Effect.gen(function* () {
        yield* setQuestion("Retry 3 times over 5 days", "Retry 3 times");
        const shown = (yield* currentDecision).decision.openedAt;
        yield* setQuestion(
          "Stop after the first decline",
          "Stop after one",
          "2026-11-13T13:00:00.000Z",
        );
        const before = (yield* coordinatorTexts).length;
        const notifier = yield* PushNotifier;
        const outcome = yield* notifier.runAction(yield* tokenFor(shown), "answer");
        expect(outcome).toEqual({ ok: false, status: 409, refusal: "outdated" });
        expect((yield* coordinatorTexts).length).toBe(before);
        expect((yield* currentDecision).decision.answeredAt).toBeUndefined();
      }),
    ),
  );

  it.effect("has the decider refuse an answer message for any other version", () =>
    withEngine(
      Effect.gen(function* () {
        yield* setQuestion("Retry 3 times over 5 days", "Retry 3 times");
        const { status, decision } = yield* currentDecision;
        const stale = "2026-11-01T00:00:00.000Z";
        const messageId = statusAnswerMessageId(PROJECT_ID, status.id, stale);
        const refused = yield* dispatch({
          type: "thread.message.user.append",
          commandId: CommandId.make(messageId),
          threadId: COORDINATOR,
          message: {
            messageId: messageId as never,
            text: recommendationReplyText(status, { ...decision, openedAt: stale }),
            attachments: [],
          },
          createdAt: NOW,
        }).pipe(Effect.flip);
        expect(refused.message).toContain("no longer matches");
      }),
    ),
  );

  it.effect("rejects a forged or foreign token", () =>
    withEngine(
      Effect.gen(function* () {
        yield* setQuestion("Retry 3 times over 5 days", "Retry 3 times");
        const notifier = yield* PushNotifier;
        expect(yield* notifier.runAction("not.a-token", "answer")).toBeNull();
        const token = yield* tokenFor((yield* currentDecision).decision.openedAt);
        const [payload] = token.split(".");
        expect(yield* notifier.runAction(`${payload}.forged`, "answer")).toBeNull();
      }),
    ),
  );
});

describe("what gets sent", () => {
  const base = {
    id: "payments-retry",
    title: "Payments retry",
    summary: "Retries wired.",
    updatedAt: NOW,
  };
  const decision = {
    question: "Retry?",
    recommendation: "Retry 3 times",
    answer: "Retry 3 times",
    openedAt: NOW,
  };

  it("sends an open question once per version", () => {
    expect(questionToSend({ ...base, state: "needs-you", decision }, undefined)).toEqual(decision);
    expect(questionToSend({ ...base, state: "needs-you", decision }, NOW)).toBeNull();
    expect(
      questionToSend({ ...base, state: "needs-you", decision }, "2026-11-12T00:00:00.000Z"),
    ).toEqual(decision);
    expect(
      questionToSend(
        { ...base, state: "needs-you", decision: { ...decision, answeredAt: NOW } },
        undefined,
      ),
    ).toBeNull();
    expect(questionToSend({ ...base, state: "working" }, undefined)).toBeNull();
  });

  it("reads finished and failed from a session leaving work", () => {
    expect(sessionOutcome("running", "ready")).toBe("finished");
    expect(sessionOutcome("running", "idle")).toBe("finished");
    expect(sessionOutcome("running", "error")).toBe("failed");
    expect(sessionOutcome("ready", "idle")).toBeNull();
    expect(sessionOutcome(undefined, "ready")).toBeNull();
    expect(sessionOutcome("running", "interrupted")).toBeNull();
  });

  it("reads an Assistant ping, ignoring malformed ones", () => {
    expect(
      assistantPingFromPayload({
        pingId: "p1",
        title: "Claude Code weekly limit runs out Thursday",
        body: "Resets Monday.",
        actions: [],
      }),
    ).toEqual({
      pingId: "p1",
      title: "Claude Code weekly limit runs out Thursday",
      body: "Resets Monday.",
    });
    expect(assistantPingFromPayload({ pingId: "p1" })).toBeNull();
    expect(assistantPingFromPayload(null)).toBeNull();
  });
});
