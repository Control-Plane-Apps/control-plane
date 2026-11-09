import { RemoteAgentsLocalOnly } from "../../../agentMachines/testFixtures.ts";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  statusReminderMessageId,
  type OrchestrationCommand,
  type ProjectAssistant,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../../../config.ts";
import { makeAgentPushQueries } from "../../../orchestration/agentPushes.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as StatusDeadlineReactor from "../../../orchestration/StatusDeadlineReactor.ts";
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionProjectRepositoryLive } from "../../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../../../persistence/Services/ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { makeProviderRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import { HostTimeZoneSource } from "../../../schedules/hostZone.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AgentsToolkitHandlersLive } from "./handlers.ts";
import { AgentsToolkit, StatusListResult, StatusSetResult } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-acme");
const OTHER_PROJECT_ID = ProjectId.make("project-other");
const COORDINATOR = ThreadId.make("thread-coordinator");
const SALES = ThreadId.make("thread-sales");
const PDF = ThreadId.make("thread-pdf");
const OTHER_COORDINATOR = ThreadId.make("thread-other-coordinator");
const CODEX = ProviderInstanceId.make("codex");
const SEEDED_AT = "2026-01-01T00:00:00.000Z";
const NOW = "2026-10-28T12:00:00.000Z";
const THURSDAY = "2026-10-29T17:00:00.000Z";

/** The real engine, projections and SQLite, so writes go through the decider as they do live. */
const TestLayer = Layer.mergeAll(
  AgentsToolkitHandlersLive,
  StatusDeadlineReactor.layer.pipe(Layer.provide(ProjectionProjectRepositoryLive)),
  ProjectionThreadMessageRepositoryLive,
).pipe(
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
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-status-tools-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

let commandCounter = 0;
const nextCommandId = () => CommandId.make(`test-command-${(commandCounter += 1)}`);

const dispatch = (command: OrchestrationCommand) =>
  Effect.flatMap(OrchestrationEngineService, (engine) => engine.dispatch(command));

const createThread = (threadId: ThreadId, projectId: ProjectId, title: string) =>
  dispatch({
    type: "thread.create",
    commandId: nextCommandId(),
    threadId,
    projectId,
    title,
    modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: SEEDED_AT,
  });

/** Project Acme: coordinator, standing agent Sales, one-off agent PDF. Project Other: its own coordinator. */
const seed = Effect.gen(function* () {
  for (const [projectId, title, coordinator] of [
    [PROJECT_ID, "Acme", COORDINATOR],
    [OTHER_PROJECT_ID, "Other", OTHER_COORDINATOR],
  ] as const) {
    yield* dispatch({
      type: "project.create",
      commandId: nextCommandId(),
      projectId,
      title,
      workspaceRoot: `/tmp/${title.toLowerCase()}`,
      createdAt: SEEDED_AT,
    });
    yield* createThread(coordinator, projectId, title);
  }
  yield* createThread(SALES, PROJECT_ID, "Sales");
  yield* createThread(PDF, PROJECT_ID, "PDF agent");
  yield* dispatch({ type: "thread.pin", commandId: nextCommandId(), threadId: SALES });
  for (const [projectId, coordinatorThreadId] of [
    [PROJECT_ID, COORDINATOR],
    [OTHER_PROJECT_ID, OTHER_COORDINATOR],
  ] as const) {
    yield* dispatch({
      type: "project.meta.update",
      commandId: nextCommandId(),
      projectId,
      assistant: { coordinatorThreadId },
    });
  }
});

const readMarker = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const readModel = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
    const assistant = readModel.projects.find((project) => project.id === projectId)?.assistant;
    if (assistant == null) throw new Error(`Project ${projectId} has no marker.`);
    return assistant;
  });

const statusOf = (marker: ProjectAssistant, id: string) => {
  const status = marker.statuses?.find((entry) => entry.id === id);
  if (status === undefined) throw new Error(`No status ${id}.`);
  return status;
};

const messagesOf = (threadId: ThreadId) =>
  Effect.flatMap(ProjectionThreadMessageRepository, (messages) =>
    messages.listByThreadId({ threadId }),
  );

const statusTools = Effect.gen(function* () {
  const toolkit = yield* AgentsToolkit;
  const run = <S extends Schema.ConstraintDecoder<unknown>, E, R>(
    handled: Effect.Effect<Stream.Stream<{ readonly result: unknown }, E, R>, E, R>,
    success: S,
    caller: ThreadId,
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
  ) =>
    handled.pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => Schema.decodeUnknownSync(success)(chunk.at(-1)!.result)),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: caller,
        providerSessionId: "provider-session-1",
        providerInstanceId: CODEX,
        capabilities: new Set(capabilities),
        issuedAt: 1,
      }),
    );
  return {
    list: (
      caller: ThreadId,
      capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["agents"],
    ) => run(toolkit.handle("cp_status_list", {}), StatusListResult, caller, capabilities),
    set: (caller: ThreadId, params: Parameters<typeof toolkit.handle<"cp_status_set">>[1]) =>
      run(toolkit.handle("cp_status_set", params), StatusSetResult, caller, ["agents"]),
  };
});

const withSeededEngine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.setTime(Date.parse(NOW)).pipe(
    Effect.andThen(seed),
    Effect.andThen(effect),
    Effect.provide(TestLayer),
    Effect.provideService(HostTimeZoneSource, () => ({ zone: "UTC", processZone: "UTC" })),
  );

const PAYOUTS = {
  id: "payouts",
  title: "Payouts",
  summary: "Connect onboarding and the payout webhook pass in sandbox.",
  detail: "The 1099 step has not run against a live account yet.",
  question: "Pilot or release to every inspector?",
  recommendation: "Pilot with 5 inspectors behind a flag",
  ifNoReply: "keep waiting and ask again Friday",
  deadline: THURSDAY,
} as const;

describe("status tool access", () => {
  it.effect("refuses a caller without the agents capability", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const error = yield* tools.list(COORDINATOR, []).pipe(Effect.flip);
        expect(error._tag).toBe("McpCapabilityUnavailableError");
      }),
    ),
  );

  it.effect("refuses a standing agent even though it holds the agents capability", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const error = yield* tools
          .set(SALES, { id: "pipeline", title: "Pipeline", summary: "Mine now." })
          .pipe(Effect.flip);
        expect(error._tag).toBe("StatusCoordinatorOnlyError");
        expect((yield* readMarker(PROJECT_ID)).statuses).toBeUndefined();
      }),
    ),
  );

  it.effect("keeps each coordinator to its own Project's board", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(OTHER_COORDINATOR, { id: "launch", title: "Launch", summary: "Soon." });
        expect((yield* tools.list(COORDINATOR)).statuses).toEqual([]);
        // An agent of another Project is not a thread this board can list.
        const error = yield* tools
          .set(OTHER_COORDINATOR, { id: "launch", agents: [PDF] })
          .pipe(Effect.flip);
        expect(error.message).toContain("is not a thread in this Project");
      }),
    ),
  );
});

describe("cp_status_set", () => {
  it.effect("writes a workstream with a decision as needs-you, and lists those first", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, {
          id: "pdf",
          title: "Report PDF export",
          summary: "Photo grids still break across pages.",
          agents: [PDF],
        });
        const result = yield* tools.set(COORDINATOR, { ...PAYOUTS, state: "working" });

        expect(result.needsYou).toBe(1);
        expect(result.status).toMatchObject({
          state: "needs-you",
          decision: {
            question: PAYOUTS.question,
            recommendation: PAYOUTS.recommendation,
            ifNoReply: PAYOUTS.ifNoReply,
            deadline: THURSDAY,
            openedAt: NOW,
          },
          updatedAt: NOW,
        });
        const listed = yield* tools.list(COORDINATOR);
        expect(listed.statuses.map((status) => status.id)).toEqual(["payouts", "pdf"]);
        expect(statusOf(yield* readMarker(PROJECT_ID), "pdf").agents).toEqual([PDF]);
      }),
    ),
  );

  it.effect("keeps a decision's version for a new recommendation and restamps a new question", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, PAYOUTS);
        yield* TestClock.adjust("1 hour");
        const tweaked = yield* tools.set(COORDINATOR, {
          id: "payouts",
          recommendation: "Pilot with 3 inspectors",
        });
        expect(tweaked.status?.decision?.openedAt).toBe(NOW);
        expect(tweaked.status?.updatedAt).not.toBe(NOW);

        const asked = yield* tools.set(COORDINATOR, {
          id: "payouts",
          question: "Pilot with Stripe-ready inspectors only?",
        });
        expect(asked.status?.decision?.openedAt).toBe(asked.status?.updatedAt);
        expect(asked.status?.decision?.recommendation).toBe("Pilot with 3 inspectors");
      }),
    ),
  );

  it.effect("clears an answered decision back to working, keeping the lines", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, PAYOUTS);
        const cleared = yield* tools.set(COORDINATOR, {
          id: "payouts",
          clearDecision: true,
          summary: "Flag going on for three pilots.",
          detail: "",
        });
        expect(cleared.needsYou).toBe(0);
        expect(cleared.status).toEqual({
          id: "payouts",
          title: "Payouts",
          state: "working",
          summary: "Flag going on for three pilots.",
          updatedAt: NOW,
        });
      }),
    ),
  );

  it.effect("refuses what would make the board wrong", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, PAYOUTS);
        const refusals = yield* Effect.forEach(
          [
            { id: "new-one", title: "No summary" },
            { id: "payouts-2", title: "payouts", summary: "Same title, other case." },
            { id: "payouts", deadline: "2026-10-01T00:00:00.000Z" },
            { id: "payouts", deadline: "next thursday" },
            { id: "payouts", clearDecision: true, question: "Both at once?" },
            { id: "nav", title: "Nav", summary: "Copy.", question: "Rename it?" },
            { id: "nav", title: "Nav", summary: "x".repeat(241) },
            { id: "missing", remove: true },
          ],
          (params) =>
            tools.set(COORDINATOR, params).pipe(
              Effect.flip,
              Effect.map((error) => error.message),
            ),
        );
        expect(refusals).toEqual([
          "A new workstream needs a title and a summary.",
          "Another workstream is already titled 'payouts'.",
          "The deadline must be in the future.",
          "Deadline 'next thursday' is not an ISO date-time.",
          "Pass clearDecision alone, or a new question without clearDecision.",
          "A decision needs both a question and your recommendation.",
          "The summary is at most 240 characters.",
          "There is no workstream 'missing'.",
        ]);
        expect((yield* readMarker(PROJECT_ID)).statuses).toHaveLength(1);
      }),
    ),
  );

  it.effect("removes a workstream", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, PAYOUTS);
        const removed = yield* tools.set(COORDINATOR, { id: "payouts", remove: true });
        expect(removed).toEqual({ id: "payouts", status: null, needsYou: 0 });
        expect((yield* readMarker(PROJECT_ID)).statuses).toBeUndefined();
      }),
    ),
  );

  it.effect("survives the user's own Project edits, such as archive and unarchive", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        yield* tools.set(COORDINATOR, PAYOUTS);
        for (const archived of [true, false]) {
          yield* dispatch({
            type: "project.meta.update",
            commandId: nextCommandId(),
            projectId: PROJECT_ID,
            assistant: { archived },
          });
        }
        expect(statusOf(yield* readMarker(PROJECT_ID), "payouts").decision?.question).toBe(
          PAYOUTS.question,
        );
      }),
    ),
  );
});

describe("StatusDeadlineReactor", () => {
  const reminders = Effect.map(messagesOf(COORDINATOR), (messages) =>
    messages.filter((message) => message.messageId.startsWith("cp-status:")),
  );

  it.effect("reminds the coordinator once when a deadline passes, never as approval", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const reactor = yield* StatusDeadlineReactor.StatusDeadlineReactor;
        yield* tools.set(COORDINATOR, PAYOUTS);

        yield* reactor.sweep;
        expect(yield* reminders).toHaveLength(0);

        yield* TestClock.setTime(Date.parse(THURSDAY) + 1);
        yield* reactor.sweep;
        yield* reactor.sweep;
        const sent = yield* reminders;
        expect(sent.map((message) => message.messageId)).toEqual([
          statusReminderMessageId(PROJECT_ID, "payouts", NOW),
        ]);
        expect(sent[0]?.source).toEqual({ kind: "agent", threadTitle: "Status" });
        // Delivered like a schedule run: the coordinator's next idle moment starts a turn on it.
        const deliveries = yield* makeAgentPushQueries(yield* SqlClient.SqlClient).listDeliveries(
          PROJECT_ID,
        );
        expect(deliveries.map((delivery) => delivery.messageId)).toEqual([sent[0]?.messageId]);
        expect(sent[0]?.text).toContain("Silence never authorizes acting for the user");
        expect(sent[0]?.text).toContain(`You said without a reply: ${PAYOUTS.ifNoReply}`);
        const decision = statusOf(yield* readMarker(PROJECT_ID), "payouts").decision;
        expect(decision?.remindedAt).toBeDefined();
        // Still waiting on the user: a reminder never answers the question.
        expect(statusOf(yield* readMarker(PROJECT_ID), "payouts").state).toBe("needs-you");
      }),
    ),
  );

  it.effect("reminds again only for a new version of the question", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const reactor = yield* StatusDeadlineReactor.StatusDeadlineReactor;
        yield* tools.set(COORDINATOR, PAYOUTS);
        yield* TestClock.setTime(Date.parse(THURSDAY) + 1);
        yield* reactor.sweep;

        const later = "2026-11-02T17:00:00.000Z";
        const moved = yield* tools.set(COORDINATOR, { id: "payouts", deadline: later });
        expect(moved.status?.decision?.remindedAt).toBeUndefined();
        yield* reactor.sweep;
        expect(yield* reminders).toHaveLength(1);

        yield* TestClock.setTime(Date.parse(later) + 1);
        yield* reactor.sweep;
        expect(yield* reminders).toHaveLength(2);
      }),
    ),
  );

  it.effect("records a reminder whose message went out before a restart, without resending", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const reactor = yield* StatusDeadlineReactor.StatusDeadlineReactor;
        yield* tools.set(COORDINATOR, PAYOUTS);
        yield* TestClock.setTime(Date.parse(THURSDAY) + 1);
        // The message from a sweep that crashed before recording it.
        const messageId = statusReminderMessageId(PROJECT_ID, "payouts", NOW);
        yield* dispatch({
          type: "thread.message.user.append",
          commandId: CommandId.make(messageId),
          threadId: COORDINATOR,
          message: {
            messageId: messageId as never,
            text: "earlier reminder",
            attachments: [],
            source: { kind: "agent", threadTitle: "Status" },
          },
          createdAt: THURSDAY,
        });
        yield* reactor.sweep;
        expect((yield* reminders).map((message) => message.text)).toEqual(["earlier reminder"]);
        expect(
          statusOf(yield* readMarker(PROJECT_ID), "payouts").decision?.remindedAt,
        ).toBeDefined();
      }),
    ),
  );

  it.effect("holds reminders while the Project is archived", () =>
    withSeededEngine(
      Effect.gen(function* () {
        const tools = yield* statusTools;
        const reactor = yield* StatusDeadlineReactor.StatusDeadlineReactor;
        yield* tools.set(COORDINATOR, PAYOUTS);
        yield* dispatch({
          type: "project.meta.update",
          commandId: nextCommandId(),
          projectId: PROJECT_ID,
          assistant: { archived: true },
        });
        yield* TestClock.setTime(Date.parse(THURSDAY) + 1);
        yield* reactor.sweep;
        expect(yield* reminders).toHaveLength(0);
      }),
    ),
  );
});
