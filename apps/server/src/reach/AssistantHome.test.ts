import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  findGlobalAssistantProject,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationCommand,
  type ServerSettings,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AgentMachines } from "../agentMachines/AgentMachines.ts";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AssistantHome, make as makeAssistantHome, suggestedAddresses } from "./AssistantHome.ts";
import { ReachBridge, type ReachAskRecord } from "./ReachBridge.ts";
import type { AssistantBundle } from "./reachProtocol.ts";
import { noteAssistantHost } from "./taskAuthority.ts";
import { makeScriptedReach, type ScriptedMachine } from "./testReach.ts";

const CODEX = ProviderInstanceId.make("codex");
const AT = "2026-11-21T09:00:00.000Z";
const SELF = "env-macbook";

let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
const tracked: Array<ReachAskRecord> = [];
const dropped: Array<string> = [];
let adoptAnswer: "ok" | "fail" = "ok";
const adoptedBundles: Array<AssistantBundle> = [];

const mini: ScriptedMachine = {
  id: "env-mini",
  label: "Mac mini",
  online: true,
  answer: (op, input) => {
    switch (op) {
      case "describe":
        return { environmentId: "env-mini", label: "Mac mini", assistant: null, linked: [SELF] };
      case "overview":
        return { projects: [], workspaces: [] };
      case "assistant.adopt":
        if (adoptAnswer === "fail") throw new Error("disk full");
        adoptedBundles.push(input as AssistantBundle);
        return { projectId: "new-home", threadId: "new-assistant" };
      default:
        throw new Error(`unexpected ${op}`);
    }
  },
};
const scripted = makeScriptedReach([mini]);

const EngineLayer = OrchestrationEngineLive.pipe(
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-assistant-home-" })),
  Layer.provideMerge(NodeServices.layer),
);

const TestLayer = Layer.effect(AssistantHome, makeAssistantHome).pipe(
  Layer.provide(ProjectionProjectRepositoryLive),
  Layer.provideMerge(
    Layer.mock(ServerSettingsService)({
      getSettings: Effect.sync(() => settings),
      updateSettings: (patch) =>
        Effect.sync(() => {
          settings = {
            ...settings,
            ...(patch.assistant !== undefined
              ? { assistant: { ...settings.assistant, ...patch.assistant } }
              : {}),
          };
          return settings;
        }),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make(SELF)),
      getDescriptor: Effect.succeed({
        environmentId: EnvironmentId.make(SELF),
        label: "MacBook",
      } as ExecutionEnvironmentDescriptor),
    }),
  ),
  Layer.provideMerge(Layer.mock(EnvironmentAuth)({})),
  Layer.provideMerge(Layer.mock(AgentMachines)({})),
  Layer.provideMerge(scripted.layer),
  Layer.provideMerge(
    Layer.succeed(ReachBridge, {
      track: (record) => Effect.sync(() => void tracked.push(record)),
      open: Effect.sync(() => tracked),
      dropFor: (replyTo) => Effect.sync(() => void dropped.push(replyTo)),
      start: () => Effect.void,
      pollOnce: Effect.void,
    }),
  ),
  Layer.provideMerge(EngineLayer),
);

let counter = 0;
const cid = () => CommandId.make(`c-${(counter += 1)}`);
const dispatch = (command: OrchestrationCommand) =>
  Effect.flatMap(OrchestrationEngineService, (engine) => engine.dispatch(command));

const seedAssistant = Effect.gen(function* () {
  yield* dispatch({
    type: "project.create",
    commandId: cid(),
    projectId: ProjectId.make("old-home"),
    title: "Assistant",
    workspaceRoot: "/tmp/old-home",
    createdAt: AT,
  });
  yield* dispatch({
    type: "thread.create",
    commandId: cid(),
    threadId: ThreadId.make("old-assistant"),
    projectId: ProjectId.make("old-home"),
    title: "Assistant",
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
    projectId: ProjectId.make("old-home"),
    assistant: {
      coordinatorThreadId: ThreadId.make("old-assistant"),
      scope: "global",
      schedules: [
        {
          id: "morning-brief",
          name: "Morning brief",
          cron: "0 7 * * 1-5",
          target: "coordinator",
          enabled: true,
          prompt: "Write my morning brief.",
        },
      ],
    },
  });
  yield* dispatch({
    type: "thread.history.import",
    commandId: cid(),
    threadId: ThreadId.make("old-assistant"),
    messages: [
      {
        messageId: "m1" as never,
        role: "user",
        text: "Remember: I like short answers.",
        createdAt: AT,
      },
      { messageId: "m2" as never, role: "assistant", text: "Noted.", createdAt: AT },
    ],
  });
});

const liveAssistant = Effect.flatMap(ProjectionSnapshotQuery, (snapshots) =>
  snapshots
    .getShellSnapshot()
    .pipe(Effect.map((snapshot) => findGlobalAssistantProject(snapshot.projects))),
);

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.sync(() => {
    settings = DEFAULT_SERVER_SETTINGS;
    tracked.length = 0;
    dropped.length = 0;
    adoptedBundles.length = 0;
    adoptAnswer = "ok";
    mini.online = true;
    noteAssistantHost("env-mini", false);
  }).pipe(Effect.andThen(effect), Effect.provide(TestLayer));

describe("AssistantHome", () => {
  it("suggests tailnet addresses first, and none while listening on loopback", () => {
    const interfaces = {
      en0: [{ address: "192.168.1.5", family: "IPv4", internal: false }],
      utun4: [{ address: "100.101.1.2", family: "IPv4", internal: false }],
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    } as never;
    expect(suggestedAddresses({ host: "127.0.0.1", port: 3773, interfaces })).toEqual([]);
    expect(suggestedAddresses({ host: "0.0.0.0", port: 3773, interfaces })).toEqual([
      "http://100.101.1.2:3773",
      "http://192.168.1.5:3773",
    ]);
  });

  it.effect("moves the Assistant: pauses it here first, sends everything, drops local asks", () =>
    run(
      Effect.gen(function* () {
        yield* seedAssistant;
        tracked.push({
          machineId: "env-x",
          machineLabel: "X",
          coordinatorThreadId: "c",
          coordinatorTitle: "C",
          messageId: "cp-send:c:ask:a:reach:1",
          replyTo: "old-assistant",
          askedAt: AT,
        });
        const home = yield* AssistantHome;
        const before = yield* home.manage({ action: "status" });
        expect(before.here).toBe(true);
        expect(before.machines[0]).toMatchObject({ id: "env-mini", linksBack: true });

        yield* home.manage({ action: "move", to: "env-mini" });

        expect(yield* liveAssistant).toBeUndefined();
        expect(dropped).toEqual(["old-assistant"]);
        const [bundle] = adoptedBundles;
        expect(bundle?.schedules.map((schedule) => [schedule.id, schedule.enabled])).toEqual([
          ["morning-brief", true],
        ]);
        expect(bundle?.messages.map((message) => message.text)).toEqual([
          "Remember: I like short answers.",
          "Noted.",
        ]);
        expect(bundle?.asks.map((ask) => ask.messageId)).toEqual(["cp-send:c:ask:a:reach:1"]);
      }),
    ),
  );

  it.effect("keeps the Assistant here when the target fails to adopt it", () =>
    run(
      Effect.gen(function* () {
        yield* seedAssistant;
        adoptAnswer = "fail";
        const home = yield* AssistantHome;
        const outcome = yield* home.manage({ action: "move", to: "env-mini" }).pipe(Effect.flip);
        expect(outcome.detail).toContain("Not moved: disk full");
        expect((yield* liveAssistant)?.id).toBe("old-home");
        expect(dropped).toEqual([]);
      }),
    ),
  );

  it.effect("refuses a target that has not linked this machine back, or is offline", () =>
    run(
      Effect.gen(function* () {
        yield* seedAssistant;
        const home = yield* AssistantHome;
        mini.online = false;
        const offline = yield* home.manage({ action: "move", to: "env-mini" }).pipe(Effect.flip);
        expect(offline.detail).toContain("Mac mini is offline");
        expect((yield* liveAssistant)?.id).toBe("old-home");
      }),
    ),
  );

  it.effect("adopts a moved Assistant with its settings, schedules and conversation", () =>
    run(
      Effect.gen(function* () {
        const home = yield* AssistantHome;
        const created = yield* home.adopt(
          {
            moveId: "move1",
            settings: { ...DEFAULT_SERVER_SETTINGS.assistant, messageCoordinators: false },
            schedules: [
              {
                id: "check-in",
                name: "Check-in",
                cron: "0 9-18/2 * * 1-5",
                enabled: false,
                prompt: "Check in",
              },
            ],
            memory: null,
            messages: [{ role: "user", text: "Hi", createdAt: AT }],
            asks: [
              {
                machineId: "env-mini",
                machineLabel: "Mac mini",
                coordinatorThreadId: "c",
                coordinatorTitle: "C",
                messageId: "cp-send:c:ask:b:reach:2",
                askedAt: AT,
              },
            ],
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
          },
          { label: "MacBook" },
        );
        const project = yield* liveAssistant;
        expect(project?.id).toBe(created.projectId);
        expect(project?.assistant?.schedules?.map((schedule) => schedule.id)).toEqual(["check-in"]);
        expect(settings.assistant.messageCoordinators).toBe(false);
        expect(tracked.map((record) => record.replyTo)).toEqual([created.threadId]);
        const again = yield* home
          .adopt(
            {
              moveId: "move2",
              settings: DEFAULT_SERVER_SETTINGS.assistant,
              schedules: [],
              memory: null,
              messages: [],
              asks: [],
              modelSelection: { instanceId: "codex", model: "gpt-5.4" },
              runtimeMode: "full-access",
            },
            { label: "MacBook" },
          )
          .pipe(Effect.flip);
        expect(again.detail).toBe("This machine already runs an Assistant.");
      }),
    ),
  );

  it.effect("refuses to create a second Assistant while a linked machine runs one", () =>
    run(
      Effect.gen(function* () {
        noteAssistantHost("env-mini", true);
        const home = yield* AssistantHome;
        const outcome = yield* home.guardEnsure.pipe(Effect.flip);
        expect(outcome.detail).toContain("Your Assistant runs on Mac mini");
      }),
    ),
  );
});
