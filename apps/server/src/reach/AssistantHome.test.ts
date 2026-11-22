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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

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
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
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
/** The environment id the server behind a pairing link reports. */
let pairingServerId = "env-mini";
let linked: Array<string> = [];
const tracked: Array<ReachAskRecord> = [];
const dropped: Array<string> = [];
let adoptAnswer: "ok" | "fail" | "timeout" = "ok";
let commitAnswer: "committed" | "timeout" | "refuse" = "committed";
let abortAnswer: "aborted" | "offline" = "aborted";
let statusAnswer: "adopted" | "committed" | "aborted" | "unknown" = "committed";
const adoptedBundles: Array<AssistantBundle> = [];
const calls: Array<string> = [];

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
        calls.push(op);
        if (adoptAnswer === "fail") throw new Error("disk full");
        if (adoptAnswer === "timeout") throw new Error("timeout: no answer");
        adoptedBundles.push(input as AssistantBundle);
        return { projectId: "new-home", threadId: "new-assistant" };
      case "assistant.commit":
        calls.push(op);
        if (commitAnswer === "timeout") throw new Error("timeout: no answer");
        if (commitAnswer === "refuse") throw new Error("There is no such move to finish here.");
        return { phase: "committed" };
      case "assistant.abort":
        calls.push(op);
        if (abortAnswer === "offline") throw new Error("offline: asleep");
        return { phase: "aborted" };
      case "assistant.moveStatus":
        calls.push(op);
        return { phase: statusAnswer };
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
  Layer.provideMerge(
    Layer.mock(AgentMachines)({
      manage: (input) =>
        Effect.sync(() => {
          linked.push(input.action);
          return { linked: { id: pairingServerId, label: "Mac mini" }, machines: [] };
        }),
    }),
  ),
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
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                environmentId: pairingServerId,
                label: "Somewhere",
                platform: { os: "darwin", arch: "arm64" },
                serverVersion: "0.0.90",
                orchestrationProtocolVersion: 1,
                capabilities: { repositoryIdentity: true },
              }),
              { headers: { "content-type": "application/json" } },
            ),
          ),
        ),
      ),
    ),
  ),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
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

const FROM = { environmentId: "env-air", label: "MacBook Air" };

const bundle = (moveId: string): AssistantBundle => ({
  moveId,
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
  memory: "# Big memory",
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
});

const memoryDir = Effect.map(ServerConfig, (config) => `${config.stateDir}/assistant`);
const memoryPath = Effect.map(memoryDir, (dir) => `${dir}/MEMORY.md`);
const readMemory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(yield* memoryPath).pipe(Effect.orElseSucceed(() => null));
});

const briefUpdatedAt = Effect.flatMap(ProjectionSnapshotQuery, (snapshots) =>
  snapshots
    .getShellSnapshot()
    .pipe(
      Effect.map(
        (snapshot) =>
          snapshot.projects
            .find((project) => project.id === "old-home")
            ?.assistant?.schedules?.find((schedule) => schedule.id === "morning-brief")?.updatedAt,
      ),
    ),
);

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
    calls.length = 0;
    adoptAnswer = "ok";
    commitAnswer = "committed";
    abortAnswer = "aborted";
    statusAnswer = "committed";
    mini.online = true;
    noteAssistantHost("env-mini", { hosts: false, at: 0 });
    pairingServerId = "env-mini";
    linked = [];
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

  it.effect("adopts a paused copy, idempotently, and puts it live only on commit", () =>
    run(
      Effect.gen(function* () {
        const home = yield* AssistantHome;
        const created = yield* home.adopt(bundle("move1"), FROM);
        // Paused: never live alongside the source's copy.
        expect(yield* liveAssistant).toBeUndefined();
        expect(settings.assistant.messageCoordinators).toBe(false);
        expect(yield* readMemory).toBe("# Big memory");
        expect(yield* home.adopt(bundle("move1"), FROM)).toEqual(created);
        expect(tracked).toEqual([]);
        expect(yield* home.moveStatus("move1")).toEqual({ phase: "adopted" });

        expect(yield* home.commit("move1")).toEqual({ phase: "committed" });
        const project = yield* liveAssistant;
        expect(project?.id).toBe(created.projectId);
        expect(project?.assistant?.schedules?.map((schedule) => schedule.id)).toEqual(["check-in"]);
        expect(tracked.map((record) => record.replyTo)).toEqual([created.threadId]);
        expect(yield* home.commit("move1")).toEqual({ phase: "committed" });

        const again = yield* home.adopt(bundle("move2"), FROM).pipe(Effect.flip);
        expect(again.detail).toBe("This machine already runs an Assistant.");
      }),
    ),
  );

  it.effect("abort deletes the copy it made and puts settings and memory back", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(yield* memoryDir, { recursive: true });
        yield* fs.writeFileString(yield* memoryPath, "# Mine");
        const home = yield* AssistantHome;
        const created = yield* home.adopt(bundle("move1"), FROM);
        expect(yield* readMemory).toBe("# Big memory");
        expect(yield* home.abort("move1", FROM)).toEqual({ phase: "aborted" });
        expect(settings.assistant.messageCoordinators).toBe(true);
        expect(yield* readMemory).toBe("# Mine");
        const projects = (yield* (yield* ProjectionSnapshotQuery).getShellSnapshot()).projects;
        expect(projects.some((project) => project.id === created.projectId)).toBe(false);
        // A late adopt for the cancelled move is refused; a new move can use the folder again.
        expect((yield* home.adopt(bundle("move1"), FROM).pipe(Effect.flip)).detail).toBe(
          "That move was cancelled.",
        );
        const retry = yield* home.adopt(bundle("move2"), FROM);
        expect(retry.projectId).not.toBe(created.projectId);
        // An abort for a move it never saw blocks that adopt later.
        yield* home.abort("move3", FROM);
        expect((yield* home.adopt(bundle("move3"), FROM).pipe(Effect.flip)).detail).toBe(
          "That move was cancelled.",
        );
      }),
    ),
  );

  it.effect("moving back reuses the archived Assistant and its folder", () =>
    run(
      Effect.gen(function* () {
        yield* seedAssistant;
        const home = yield* AssistantHome;
        // A to B: this machine pauses its copy.
        yield* home.manage({ action: "move", to: "env-mini" });
        expect(yield* liveAssistant).toBeUndefined();
        // B to A: the bundle repeats the old messages and adds one.
        const back = bundle("move-back");
        const returned = yield* home.adopt(
          {
            ...back,
            messages: [
              { role: "user", text: "Remember: I like short answers.", createdAt: AT },
              { role: "assistant", text: "Noted.", createdAt: AT },
              { role: "user", text: "Said on the mini", createdAt: "2026-11-21T10:00:00.000Z" },
            ],
          },
          FROM,
        );
        expect(returned.projectId).toBe("old-home");
        expect(returned.threadId).not.toBe("old-assistant");
        yield* home.commit("move-back");
        const live = yield* liveAssistant;
        expect(live?.id).toBe("old-home");
        expect(live?.assistant?.coordinatorThreadId).toBe(returned.threadId);
        const texts = (yield* (yield* ProjectionThreadMessageRepository).listByThreadId({
          threadId: ThreadId.make(returned.threadId),
        })).map((message) => message.text);
        expect(texts).toEqual(["Remember: I like short answers.", "Noted.", "Said on the mini"]);
      }),
    ),
  );

  it.effect("rolls back when adopt times out, even if the target cannot be told", () =>
    run(
      Effect.gen(function* () {
        yield* seedAssistant;
        adoptAnswer = "timeout";
        abortAnswer = "offline";
        const home = yield* AssistantHome;
        const outcome = yield* home.manage({ action: "move", to: "env-mini" }).pipe(Effect.flip);
        expect(outcome.detail).toContain("Your Assistant stays here");
        // Its copy there is paused until a commit only this machine sends: resuming is safe.
        expect((yield* liveAssistant)?.id).toBe("old-home");
        expect(calls).toEqual(["assistant.adopt", "assistant.abort"]);
        // Reconcile keeps telling the target until it hears.
        abortAnswer = "aborted";
        yield* home.reconcile;
        expect(calls.at(-1)).toBe("assistant.abort");
      }),
    ),
  );

  it.effect("stays paused when commit goes unanswered, then reconciles", () =>
    run(
      Effect.gen(function* () {
        yield* seedAssistant;
        commitAnswer = "timeout";
        const home = yield* AssistantHome;
        const outcome = yield* home.manage({ action: "move", to: "env-mini" }).pipe(Effect.flip);
        expect(outcome.detail).toContain("has not confirmed");
        // Zero or one live, never two: the target may already be running it.
        expect(yield* liveAssistant).toBeUndefined();
        expect((yield* home.manage({ action: "status" })).pendingMove?.label).toBe("Mac mini");
        // The target says it never committed: this machine resumes.
        statusAnswer = "aborted";
        yield* home.reconcile;
        expect((yield* liveAssistant)?.id).toBe("old-home");
      }),
    ),
  );

  it.effect("finishes a commit-pending move once the target says it committed", () =>
    run(
      Effect.gen(function* () {
        yield* seedAssistant;
        commitAnswer = "timeout";
        const home = yield* AssistantHome;
        yield* home.manage({ action: "move", to: "env-mini" }).pipe(Effect.flip);
        statusAnswer = "committed";
        yield* home.reconcile;
        expect(yield* liveAssistant).toBeUndefined();
        expect(dropped).toEqual(["old-assistant"]);
        expect((yield* home.manage({ action: "status" })).pendingMove).toBeUndefined();
      }),
    ),
  );

  it.effect("carries a schedule aimed at another thread, paused, and says so", () =>
    run(
      Effect.gen(function* () {
        yield* seedAssistant;
        yield* dispatch({
          type: "thread.create",
          commandId: cid(),
          threadId: ThreadId.make("side-channel"),
          projectId: ProjectId.make("old-home"),
          title: "Research",
          modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: AT,
        });
        yield* dispatch({
          type: "thread.pin",
          commandId: cid(),
          threadId: ThreadId.make("side-channel"),
        });
        yield* dispatch({
          type: "project.meta.update",
          commandId: cid(),
          projectId: ProjectId.make("old-home"),
          assistant: {
            coordinatorThreadId: ThreadId.make("old-assistant"),
            schedules: [
              {
                id: "morning-brief",
                name: "Morning brief",
                cron: "0 7 * * 1-5",
                target: "coordinator",
                enabled: true,
                updatedAt: yield* briefUpdatedAt,
              },
              {
                id: "research",
                name: "Weekly research",
                cron: "0 9 * * 1",
                target: ThreadId.make("side-channel"),
                enabled: true,
                prompt: "Research",
              },
            ],
          },
        });
        const home = yield* AssistantHome;
        const moved = yield* home.manage({ action: "move", to: "env-mini" });
        expect(moved.notes).toEqual([
          '"Weekly research" ran in another thread here, so it now runs in the Assistant and is paused. Turn it on in Settings, Assistant, Schedules if you still want it.',
        ]);
        expect(
          adoptedBundles[0]?.schedules.map((schedule) => [schedule.id, schedule.enabled]),
        ).toEqual([
          ["morning-brief", true],
          ["research", false],
        ]);
      }),
    ),
  );

  it.effect("links back only to the machine that asked", () =>
    run(
      Effect.gen(function* () {
        const home = yield* AssistantHome;
        const url = "http://127.0.0.1:47781/pair#token=ABCDEF123456";
        pairingServerId = "env-attacker";
        const refused = yield* home
          .redeemLinkBack(url, { environmentId: "env-mini", label: "Mac mini" })
          .pipe(Effect.flip);
        expect(refused.detail).toBe(
          "The pairing link is for a different machine than the one asking.",
        );
        expect(linked).toEqual([]);
        pairingServerId = "env-mini";
        const done = yield* home.redeemLinkBack(url, {
          environmentId: "env-mini",
          label: "Mac mini",
        });
        expect(done).toEqual({ id: "env-mini", label: "Mac mini" });
        expect(linked).toEqual(["link"]);
      }),
    ),
  );

  it.effect("refuses to create a second Assistant while a linked machine runs one", () =>
    run(
      Effect.gen(function* () {
        noteAssistantHost("env-mini", { hosts: true, at: 0 });
        const home = yield* AssistantHome;
        const outcome = yield* home.guardEnsure.pipe(Effect.flip);
        expect(outcome.detail).toContain("Your Assistant runs on Mac mini");
      }),
    ),
  );
});
