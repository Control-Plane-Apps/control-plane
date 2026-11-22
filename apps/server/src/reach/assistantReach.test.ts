import {
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

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadActivityRepositoryLive } from "../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { AssistantToolkitHandlers } from "../mcp/toolkits/assistant/handlers.ts";
import {
  AssistantAskResult,
  AssistantOverviewResult,
  AssistantPingResult,
  AssistantToolkit,
} from "../mcp/toolkits/assistant/tools.ts";
import { ThreadsToolkitHandlers } from "../mcp/toolkits/threads/handlers.ts";
import { ThreadSendResult, ThreadsToolkit } from "../mcp/toolkits/threads/tools.ts";
import { AgentLineage } from "../orchestration/agentLineage.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { RemoteAgents } from "../agentMachines/RemoteAgents.ts";
import { ReachBridge, type ReachAskRecord } from "./ReachBridge.ts";
import type { OverviewResult } from "./reachProtocol.ts";
import { makeScriptedReach, type ScriptedMachine } from "./testReach.ts";

// The Assistant's side: its tools reach Projects on a scripted linked machine.

const CODEX = ProviderInstanceId.make("codex");
const AT = "2026-11-21T09:00:00.000Z";
const LOCAL = ProjectId.make("local-project");
const HOME = ProjectId.make("assistant-home");
const LOCAL_COORD = ThreadId.make("local-coord");
const ASSISTANT = ThreadId.make("assistant");

const MACBOOK_OVERVIEW: OverviewResult = {
  projects: [
    {
      projectId: "hometrace",
      title: "Hometrace",
      coordinatorThreadId: "ht-coord",
      coordinatorPhase: "idle",
      needsYou: [
        {
          statusId: "launch",
          title: "Launch",
          question: "Ship Friday?",
          recommendation: "Ship Friday.",
        },
      ],
      moving: [],
    },
  ],
  workspaces: [
    {
      threadId: "ws-1",
      title: "Scratch",
      workspace: "Notes",
      phase: "idle",
      updatedAt: "2026-11-21T08:59:00.000Z",
    },
  ],
};

let remoteAssistant = false;

const macbook: ScriptedMachine = {
  id: "env-macbook",
  label: "MacBook",
  online: true,
  answer: (op, input) => {
    switch (op) {
      case "overview":
        return MACBOOK_OVERVIEW;
      case "describe":
        return {
          environmentId: "env-macbook",
          label: "MacBook",
          assistant: remoteAssistant ? { threadId: "remote-assistant", projectId: "home" } : null,
        };
      case "assistant.note":
        return { threadId: "remote-assistant", threadTitle: "Assistant", queued: false };
      case "ask":
        return {
          projectId: (input as { projectId: string }).projectId,
          title: "Hometrace",
          coordinatorThreadId: "ht-coord",
          messageId: "cp-send:ht-coord:ask:x:reach:1",
          startedNow: true,
        };
      case "thread.find":
        return (input as { ref: string }).ref === "Hometrace"
          ? { matches: [{ threadId: "ht-coord", title: "Hometrace" }] }
          : { matches: [] };
      case "thread.send":
        return (input as { threadId: string }).threadId === "remote-assistant"
          ? { threadId: "remote-assistant", threadTitle: "Assistant", queued: false }
          : { threadId: "ht-coord", threadTitle: "Hometrace", queued: true };
      default:
        throw new Error(`unexpected ${op}`);
    }
  },
};

const scripted = makeScriptedReach([macbook]);
const tracked: Array<ReachAskRecord> = [];

const EngineLayer = OrchestrationEngineLive.pipe(
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-assistant-reach-" })),
  Layer.provideMerge(NodeServices.layer),
);

const TestLayer = Layer.mergeAll(
  AssistantToolkitHandlers,
  ThreadsToolkitHandlers,
  ProjectionThreadMessageRepositoryLive,
  ProjectionThreadActivityRepositoryLive,
  ProjectionTurnRepositoryLive,
).pipe(
  Layer.provideMerge(
    Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) }),
  ),
  Layer.provideMerge(scripted.layer),
  Layer.provideMerge(
    Layer.succeed(ReachBridge, {
      track: (record) => Effect.sync(() => void tracked.push(record)),
      open: Effect.sync(() => tracked),
      start: () => Effect.void,
      pollOnce: Effect.void,
    }),
  ),
  Layer.provideMerge(Layer.mock(AgentLineage)({ creatorOf: () => Effect.succeed(null) })),
  Layer.provideMerge(
    Layer.mock(RemoteAgents)({
      find: () => Effect.succeed([]),
      list: () => Effect.succeed([]),
    }),
  ),
  Layer.provideMerge(EngineLayer),
);

let counter = 0;
const cid = () => CommandId.make(`c-${(counter += 1)}`);
const dispatch = (command: OrchestrationCommand) =>
  Effect.flatMap(OrchestrationEngineService, (engine) => engine.dispatch(command));

const seed = (withAssistant: boolean) =>
  Effect.gen(function* () {
    const rows: ReadonlyArray<readonly [ProjectId, ThreadId, string, "global" | undefined]> = [
      [LOCAL, LOCAL_COORD, "Local", undefined],
      ...(withAssistant ? [[HOME, ASSISTANT, "Assistant", "global"] as const] : []),
    ];
    for (const [projectId, coord, title, scope] of rows) {
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
  });

const invocation = (caller: ThreadId) => ({
  environmentId: EnvironmentId.make("env-mini"),
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

const assistantTool = <S extends Schema.ConstraintDecoder<unknown>>(
  name: "cp_assistant_overview" | "cp_assistant_ask" | "cp_assistant_ping",
  input: object,
  success: S,
  caller: ThreadId,
) =>
  Effect.flatMap(AssistantToolkit, (toolkit) =>
    lastResult(toolkit.handle(name, input as never), success, caller),
  );

const send = (
  caller: ThreadId,
  input: { threadTitle?: string; threadId?: string; message: string },
) =>
  Effect.flatMap(ThreadsToolkit, (toolkit) =>
    lastResult(toolkit.handle("cp_thread_send", input as never), ThreadSendResult, caller),
  );

const run = <A, E, R>(effect: Effect.Effect<A, E, R>, withAssistant = true) =>
  Effect.sync(() => {
    scripted.calls.length = 0;
    tracked.length = 0;
    macbook.online = true;
    remoteAssistant = false;
  }).pipe(Effect.andThen(seed(withAssistant)), Effect.andThen(effect), Effect.provide(TestLayer));

describe("the Assistant across servers", () => {
  it.effect("overview lists linked machines' Projects, then their last state when offline", () =>
    run(
      Effect.gen(function* () {
        const online = yield* assistantTool(
          "cp_assistant_overview",
          {},
          AssistantOverviewResult,
          ASSISTANT,
        );
        expect(online.projects.map((project) => [project.title, project.machine])).toEqual([
          ["Local", undefined],
          ["Hometrace", "MacBook"],
        ]);
        expect(online.workspaces?.map((thread) => thread.machine)).toEqual(["MacBook"]);
        expect(online.machines).toEqual([{ label: "MacBook", status: "online" }]);

        macbook.online = false;
        const offline = yield* assistantTool(
          "cp_assistant_overview",
          {},
          AssistantOverviewResult,
          ASSISTANT,
        );
        const stale = offline.projects.find((project) => project.title === "Hometrace");
        expect(stale?.stale).toBe(true);
        expect(stale?.coordinatorPhase).toBe("offline");
        expect(offline.machines?.[0]?.status).toBe("offline");
        expect(offline.machines?.[0]?.detail).toContain("MacBook is offline");
      }),
    ),
  );

  it.effect("ask reaches the remote coordinator and tracks its answer", () =>
    run(
      Effect.gen(function* () {
        const result = yield* assistantTool(
          "cp_assistant_ask",
          { question: "What is blocked?" },
          AssistantAskResult,
          ASSISTANT,
        );
        expect(result.asked.map((target) => [target.title, target.machine])).toEqual([
          ["Local", undefined],
          ["Hometrace", "MacBook"],
        ]);
        expect(tracked.map((record) => [record.coordinatorThreadId, record.replyTo])).toEqual([
          ["ht-coord", ASSISTANT],
        ]);
        expect(scripted.calls.find((entry) => entry.op === "ask")?.input).toMatchObject({
          askId: result.askId,
          projectId: "hometrace",
        });
      }),
    ),
  );

  it.effect("ask skips an offline machine's Projects with the reason, no silent drop", () =>
    run(
      Effect.gen(function* () {
        // Seen once, so its Projects are known.
        yield* assistantTool("cp_assistant_overview", {}, AssistantOverviewResult, ASSISTANT);
        macbook.online = false;
        const result = yield* assistantTool(
          "cp_assistant_ask",
          { question: "What is blocked?" },
          AssistantAskResult,
          ASSISTANT,
        );
        expect(result.asked.map((target) => target.title)).toEqual(["Local"]);
        expect(result.skipped).toEqual([
          {
            projectId: "hometrace",
            reason: "MacBook is offline. Nothing was sent; try again when it is awake.",
          },
        ]);
        expect(tracked).toEqual([]);
      }),
    ),
  );

  it.effect("the Assistant sends to a thread on a linked machine by title", () =>
    run(
      Effect.gen(function* () {
        const sent = yield* send(ASSISTANT, { threadTitle: "Hometrace", message: "Status?" });
        expect(sent).toEqual({
          threadId: "ht-coord",
          threadTitle: "Hometrace (on MacBook)",
          queued: true,
        });
      }),
    ),
  );

  it.effect("a coordinator's ping becomes a note in the local Assistant's thread", () =>
    run(
      Effect.gen(function* () {
        const result = yield* assistantTool(
          "cp_assistant_ping",
          { title: "Deploy stuck", body: "CI red for an hour." },
          AssistantPingResult,
          LOCAL_COORD,
        );
        expect(result.sentToAssistant).toBe(true);
        const messages = yield* (yield* ProjectionThreadMessageRepository).listByThreadId({
          threadId: ASSISTANT,
        });
        expect(messages.at(-1)?.text).toContain("The Local coordinator sent you a heads-up");
        expect(messages.at(-1)?.text).toContain("CI red for an hour.");
      }),
    ),
  );

  it.effect("a coordinator reaches the Assistant on a linked machine by name and by ping", () =>
    run(
      Effect.sync(() => void (remoteAssistant = true)).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const sent = yield* send(LOCAL_COORD, { threadTitle: "Assistant", message: "Done" });
            expect(sent).toEqual({
              threadId: "remote-assistant",
              threadTitle: "Assistant (on MacBook)",
              queued: false,
            });
            const pinged = yield* assistantTool(
              "cp_assistant_ping",
              { title: "Deploy stuck" },
              AssistantPingResult,
              LOCAL_COORD,
            );
            expect(pinged).toMatchObject({ sentToAssistant: true, machine: "MacBook" });
            expect(scripted.calls.map((entry) => entry.op)).toEqual([
              "thread.send",
              "assistant.note",
            ]);
          }),
        ),
      ),
      false,
    ),
  );

  it.effect("a coordinator's ping fails clearly when the Assistant's machine is offline", () =>
    run(
      Effect.gen(function* () {
        macbook.online = false;
        const outcome = yield* assistantTool(
          "cp_assistant_ping",
          { title: "Deploy stuck" },
          AssistantPingResult,
          LOCAL_COORD,
        ).pipe(Effect.flip);
        expect(String((outcome as { message?: string }).message)).toContain(
          "The user's Assistant is not on this machine, and MacBook is offline",
        );
        const sent = yield* send(LOCAL_COORD, { threadTitle: "Assistant", message: "Done" }).pipe(
          Effect.flip,
        );
        expect(String((sent as { message?: string }).message)).toContain(
          "No Assistant here, and MacBook is offline",
        );
      }),
      false,
    ),
  );

  it.effect("the Assistant's send to an offline machine says so instead of 'no thread'", () =>
    run(
      Effect.gen(function* () {
        macbook.online = false;
        const sent = yield* send(ASSISTANT, { threadTitle: "Hometrace", message: "Status?" }).pipe(
          Effect.flip,
        );
        expect(String((sent as { message?: string }).message)).toBe(
          "No thread matched Hometrace here, and MacBook is offline, last seen 2026-11-21T08:00:00.000Z, so it may be there. Nothing was sent; try again when it is awake.",
        );
      }),
    ),
  );
});
