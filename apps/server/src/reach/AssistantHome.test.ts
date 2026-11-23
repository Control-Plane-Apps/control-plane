import {
  AssistantHomeError,
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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
import {
  AssistantHome,
  blocksSchedules,
  faultsAllowedFor,
  make as makeAssistantHome,
  suggestedAddresses,
} from "./AssistantHome.ts";
import { MoveRecord } from "./assistantMoves.ts";
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
let miniLinkHealth: "connected" | "needs-relink" = "connected";
const tracked: Array<ReachAskRecord> = [];
const dropped: Array<string> = [];
let adoptAnswer: "ok" | "fail" | "timeout" = "ok";
let commitAnswer: "committed" | "timeout" | "refuse" = "committed";
let abortAnswer: "aborted" | "offline" = "aborted";
let statusAnswer: "adopted" | "committed" | "aborted" | "unknown" = "committed";
const adoptedBundles: Array<AssistantBundle> = [];
/** Whether the mini says it runs a live Assistant. */
let miniHosts = false;
/** When set, the mini answers `describe` with this error (an older build, a token to relink). */
let describeError: string | null = null;
const calls: Array<string> = [];

const mini: ScriptedMachine = {
  id: "env-mini",
  label: "Mac mini",
  online: true,
  answer: (op, input) => {
    switch (op) {
      case "describe":
        if (describeError !== null) throw new Error(describeError);
        return {
          environmentId: "env-mini",
          label: "Mac mini",
          assistant: miniHosts ? { threadId: "mini-assistant", projectId: "mini-home" } : null,
          linked: [SELF],
        };
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
        miniHosts = true;
        return { phase: "committed" };
      case "assistant.abort":
        calls.push(op);
        if (abortAnswer === "offline") throw new Error("offline: asleep");
        return { phase: "aborted" };
      case "assistant.moveStatus":
        calls.push(op);
        return { phase: statusAnswer };
      case "assistant.yield":
        calls.push(op);
        return { paused: true };
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
      healthOf: () => Effect.succeed({ status: miniLinkHealth, detail: null, lastSeenAt: null }),
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

const journalPath = Effect.map(ServerConfig, (config) => `${config.stateDir}/assistant-moves.json`);
const JournalJson = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), moves: Schema.Array(MoveRecord) }),
);
const decodeJournal = Schema.decodeUnknownEffect(JournalJson);
const encodeJournal = Schema.encodeEffect(JournalJson);
const readJournal = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(yield* journalPath);
  return (yield* decodeJournal(raw)).moves;
});
const writeJournal = (moves: ReadonlyArray<MoveRecord>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* encodeJournal({ version: 1, moves });
    yield* fs.writeFileString(yield* journalPath, contents);
  });
const projectIds = Effect.flatMap(ProjectionSnapshotQuery, (snapshots) =>
  snapshots
    .getShellSnapshot()
    .pipe(Effect.map((snapshot) => snapshot.projects.map((p) => p.id as string))),
);
/** Long enough ago that what a machine said has expired. */
const LONG_AGO = -4 * 24 * 60 * 60 * 1000;

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
    miniHosts = false;
    describeError = null;
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

        expect(yield* home.commit("move1", FROM)).toEqual({ phase: "committed" });
        const project = yield* liveAssistant;
        expect(project?.id).toBe(created.projectId);
        expect(project?.assistant?.schedules?.map((schedule) => schedule.id)).toEqual(["check-in"]);
        expect(tracked.map((record) => record.replyTo)).toEqual([created.threadId]);
        expect(yield* home.commit("move1", FROM)).toEqual({ phase: "committed" });

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
            // The archived copy here still has this schedule: rewriting it must still work.
            schedules: [
              {
                id: "morning-brief",
                name: "Morning brief",
                cron: "0 8 * * 1-5",
                enabled: true,
                prompt: "Brief me",
              },
            ],
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
        yield* home.commit("move-back", FROM);
        expect(
          (yield* liveAssistant)?.assistant?.schedules?.map((schedule) => [
            schedule.id,
            schedule.cron,
          ]),
        ).toEqual([["morning-brief", "0 8 * * 1-5"]]);
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

  const threadState = (threadId: string) =>
    Effect.gen(function* () {
      const snapshots = yield* ProjectionSnapshotQuery;
      const thread = (yield* snapshots.getCommandReadModel()).threads.find(
        (entry) => entry.id === threadId,
      );
      return {
        archived: thread?.archivedAt != null,
        pinned: thread?.pinnedAt != null,
        deleted: thread?.deletedAt != null,
      };
    });

  it.effect(
    "moving back leaves no pinned previous Assistant: the old coordinator is archived",
    () =>
      run(
        Effect.gen(function* () {
          yield* seedAssistant;
          const home = yield* AssistantHome;
          yield* home.manage({ action: "move", to: "env-mini" });
          const returned = yield* home.adopt(bundle("move-back"), FROM);
          // Before commit the old coordinator is kept as is: an abort makes it the coordinator again.
          expect((yield* threadState("old-assistant")).archived).toBe(false);
          yield* home.commit("move-back", FROM);
          expect(yield* threadState("old-assistant")).toEqual({
            archived: true,
            pinned: false,
            deleted: false,
          });
          const live = yield* liveAssistant;
          expect(live?.assistant?.coordinatorThreadId).toBe(returned.threadId);
          expect(yield* threadState(returned.threadId)).toEqual({
            archived: false,
            pinned: false,
            deleted: false,
          });
        }),
      ),
  );

  it.effect("an aborted move back keeps the old coordinator live and in charge", () =>
    run(
      Effect.gen(function* () {
        yield* seedAssistant;
        const home = yield* AssistantHome;
        yield* home.manage({ action: "move", to: "env-mini" });
        yield* home.adopt(bundle("move-back"), FROM);
        yield* home.abort("move-back", FROM);
        expect((yield* threadState("old-assistant")).archived).toBe(false);
        const snapshots = yield* ProjectionSnapshotQuery;
        const project = (yield* snapshots.getShellSnapshot()).projects.find(
          (entry) => entry.id === "old-home",
        );
        expect(project?.assistant?.coordinatorThreadId).toBe("old-assistant");
      }),
    ),
  );

  it.effect("reconcile archives a previous coordinator an older build left pinned", () =>
    run(
      Effect.gen(function* () {
        yield* seedAssistant;
        const home = yield* AssistantHome;
        const engine = yield* OrchestrationEngineService;
        yield* home.manage({ action: "move", to: "env-mini" });
        yield* home.adopt(bundle("move-back"), FROM);
        yield* home.commit("move-back", FROM);
        // As an older build left it: unarchived and pinned as a standing agent.
        yield* engine.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("test:unarchive-old"),
          threadId: ThreadId.make("old-assistant"),
        });
        yield* engine.dispatch({
          type: "thread.pin",
          commandId: CommandId.make("test:pin-old"),
          threadId: ThreadId.make("old-assistant"),
        });
        expect(yield* threadState("old-assistant")).toMatchObject({
          archived: false,
          pinned: true,
        });
        yield* home.reconcile;
        expect(yield* threadState("old-assistant")).toEqual({
          archived: true,
          pinned: false,
          deleted: false,
        });
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
          .redeemLinkBack(url, { environmentId: "env-mini", label: "Mac mini" }, Effect.void)
          .pipe(Effect.flip);
        expect(refused.detail).toBe(
          "The pairing link is for a different machine than the one asking.",
        );
        expect(linked).toEqual([]);
        pairingServerId = "env-mini";
        const done = yield* home.redeemLinkBack(
          url,
          { environmentId: "env-mini", label: "Mac mini" },
          Effect.void,
        );
        expect(done).toEqual({ id: "env-mini", label: "Mac mini" });
        expect(linked).toEqual(["link"]);
      }),
    ),
  );

  it.effect("checks who asked for a link back: first when linked, over the new link when not", () =>
    run(
      Effect.gen(function* () {
        const home = yield* AssistantHome;
        const url = "http://127.0.0.1:47781/pair#token=ABCDEF123456";
        const order: Array<string> = [];
        const says = (sent: boolean) =>
          Effect.sync(() => void order.push(`confirm after ${linked.length} link calls`)).pipe(
            Effect.andThen(
              sent
                ? Effect.void
                : Effect.fail(
                    new AssistantHomeError({
                      detail: "Mac mini did not send this request, so nothing was done.",
                    }),
                  ),
            ),
          );
        // Already linked: confirmed before anything changes; a no changes nothing.
        const refused = yield* home
          .redeemLinkBack(url, { environmentId: "env-mini", label: "Mac mini" }, says(false))
          .pipe(Effect.flip);
        expect(refused.detail).toContain("did not send this request");
        expect(order).toEqual(["confirm after 0 link calls"]);
        expect(linked).toEqual([]);
        // A new machine: the link has to exist to ask it, so it is removed again on a no.
        pairingServerId = "env-new";
        const fromNew = { environmentId: "env-new", label: "New Mac" };
        yield* home.redeemLinkBack(url, fromNew, says(false)).pipe(Effect.flip);
        expect(linked).toEqual(["link", "unlink"]);
        linked = [];
        expect(yield* home.redeemLinkBack(url, fromNew, says(true))).toMatchObject({
          id: "env-new",
        });
        expect(linked).toEqual(["link"]);
      }),
    ),
  );

  it.effect(
    "relinks an existing link whose token was refused, then confirms over the new one",
    () =>
      run(
        Effect.gen(function* () {
          const home = yield* AssistantHome;
          const url = "http://127.0.0.1:47781/pair#token=ABCDEF123456";
          pairingServerId = "env-mini";
          linked = [];
          miniLinkHealth = "needs-relink";
          // This machine has env-mini at the pairing link's address.
          const before = settings;
          settings = {
            ...settings,
            agentPlacement: {
              ...settings.agentPlacement,
              machines: {
                "env-mini": {
                  label: "Mac mini",
                  baseUrl: "http://127.0.0.1:47781",
                  enabled: true,
                  preference: 50,
                },
              },
            },
          };
          let confirms = 0;
          // The old link cannot confirm (its token expired); the new link can.
          const confirm = Effect.suspend(() =>
            ++confirms === 1
              ? Effect.fail(
                  new AssistantHomeError({ detail: "The linked machine refused the token." }),
                )
              : Effect.void,
          );
          const done = yield* home.redeemLinkBack(
            url,
            { environmentId: "env-mini", label: "Mac mini" },
            confirm,
          );
          expect(done).toMatchObject({ id: "env-mini" });
          expect(linked).toEqual(["link"]);
          expect(confirms).toBe(2);

          // A pairing link at another address cannot take the link over, even with env-mini's id.
          linked = [];
          confirms = 0;
          const elsewhere = yield* home
            .redeemLinkBack(
              "http://127.0.0.1:47799/pair#token=ABCDEF123456",
              { environmentId: "env-mini", label: "Mac mini" },
              confirm,
            )
            .pipe(Effect.flip);
          expect(elsewhere.detail).toContain("different address");
          expect(linked).toEqual([]);
          miniLinkHealth = "connected";
          settings = before;
        }),
      ),
  );

  it.effect("refuses to create a second Assistant while a linked machine runs one", () =>
    run(
      Effect.gen(function* () {
        noteAssistantHost("env-mini", { hosts: true, at: 0 });
        miniHosts = true;
        const home = yield* AssistantHome;
        const outcome = yield* home.guardEnsure.pipe(Effect.flip);
        expect(outcome.detail).toContain("Your Assistant runs on Mac mini");
        // Off, as last heard running it: still refused, pointing at taking it back.
        mini.online = false;
        expect((yield* home.guardEnsure.pipe(Effect.flip)).detail).toContain(
          "which cannot be reached",
        );
        expect(yield* liveAssistant).toBeUndefined();
      }),
    ),
  );
  it.effect("a crash mid-adopt leaves a paused, journaled copy that reconcile removes", () =>
    run(
      Effect.gen(function* () {
        const home = yield* AssistantHome;
        const created = yield* home.adopt(bundle("crash1"), FROM);
        // Never live, even before the commit.
        expect(yield* liveAssistant).toBeUndefined();
        // As if the server died before it recorded `adopted`: the journal already names the copy.
        const moves = yield* readJournal;
        expect(moves.find((move) => move.moveId === "crash1")).toMatchObject({
          role: "target",
          projectId: created.projectId,
        });
        yield* writeJournal(
          moves.map((move) =>
            move.moveId === "crash1" ? ({ ...move, phase: "preparing" } as MoveRecord) : move,
          ),
        );
        // The restarted server reconciles: the half-built copy and its memory are gone.
        const restarted = yield* makeAssistantHome;
        expect(yield* restarted.moveStatus("crash1")).toEqual({ phase: "unknown" });
        yield* restarted.reconcile;
        expect(yield* projectIds).not.toContain(created.projectId);
        expect(yield* readMemory).toBeNull();
        expect(yield* restarted.moveStatus("crash1")).toEqual({ phase: "aborted" });
        expect(yield* liveAssistant).toBeUndefined();
      }),
    ),
  );

  it.effect(
    "a retried adopt after a crash rebuilds the copy instead of returning a broken one",
    () =>
      run(
        Effect.gen(function* () {
          const home = yield* AssistantHome;
          const first = yield* home.adopt(bundle("crash2"), FROM);
          yield* writeJournal(
            (yield* readJournal).map((move) =>
              move.moveId === "crash2" ? ({ ...move, phase: "preparing" } as MoveRecord) : move,
            ),
          );
          const restarted = yield* makeAssistantHome;
          const second = yield* restarted.adopt(bundle("crash2"), FROM);
          expect(second.projectId).not.toBe(first.projectId);
          expect(yield* projectIds).not.toContain(first.projectId);
          expect(yield* restarted.moveStatus("crash2")).toEqual({ phase: "adopted" });
          expect(yield* liveAssistant).toBeUndefined();
        }),
      ),
  );

  it.effect("a failed adopt removes what it made", () =>
    run(
      Effect.gen(function* () {
        const home = yield* AssistantHome;
        const before = yield* projectIds;
        const failed = yield* home
          .adopt({ ...bundle("bad"), settings: { messageCoordinators: "yes" } }, FROM)
          .pipe(Effect.flip);
        expect(failed.detail).toContain("settings could not be read");
        expect(yield* projectIds).toEqual(before);
        expect(yield* home.moveStatus("bad")).toEqual({ phase: "aborted" });
      }),
    ),
  );

  it.effect("an unreadable journal fails closed: no rollback, no adopt", () =>
    run(
      Effect.gen(function* () {
        yield* seedAssistant;
        const home = yield* AssistantHome;
        commitAnswer = "timeout";
        yield* home.manage({ action: "move", to: "env-mini" }).pipe(Effect.flip);
        expect(yield* liveAssistant).toBeUndefined();
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(yield* journalPath, "{ not json");
        statusAnswer = "aborted";
        const restarted = yield* makeAssistantHome;
        yield* restarted.reconcile;
        // Still paused: it cannot know the target did not go live.
        expect(yield* liveAssistant).toBeUndefined();
        const refused = yield* restarted.adopt(bundle("other"), FROM).pipe(Effect.flip);
        expect(refused.detail).toContain("cannot be read");
        expect((yield* restarted.manage({ action: "status" }).pipe(Effect.flip)).detail).toContain(
          "cannot be read",
        );
      }),
    ),
  );

  it.effect("only the machine that started a move can commit or abort it", () =>
    run(
      Effect.gen(function* () {
        const home = yield* AssistantHome;
        yield* home.adopt(bundle("mine"), FROM);
        const stranger = { environmentId: "env-other", label: "Other" };
        expect((yield* home.commit("mine", stranger).pipe(Effect.flip)).detail).toBe(
          "Only MacBook Air, which started this move, can finish or cancel it.",
        );
        expect((yield* home.abort("mine", stranger).pipe(Effect.flip)).detail).toContain(
          "Only MacBook Air",
        );
        expect(yield* home.moveStatus("mine")).toEqual({ phase: "adopted" });
        expect(yield* liveAssistant).toBeUndefined();
        expect(yield* home.commit("mine", FROM)).toEqual({ phase: "committed" });
      }),
    ),
  );

  it.effect("abort removes the moved memory when this machine had none", () =>
    run(
      Effect.gen(function* () {
        const home = yield* AssistantHome;
        expect(yield* readMemory).toBeNull();
        yield* home.adopt(bundle("nomem"), FROM);
        expect(yield* readMemory).toBe("# Big memory");
        yield* home.abort("nomem", FROM);
        expect(yield* readMemory).toBeNull();
      }),
    ),
  );

  it.effect("opening the Assistant brings back the archived copy once no machine runs one", () =>
    run(
      Effect.gen(function* () {
        yield* seedAssistant;
        const home = yield* AssistantHome;
        yield* home.manage({ action: "move", to: "env-mini" });
        expect(yield* liveAssistant).toBeUndefined();
        // While the mini is known to run it: refused.
        expect((yield* home.guardEnsure.pipe(Effect.flip)).detail).toContain(
          "Your Assistant runs on Mac mini",
        );
        // Last heard running it a week ago, and offline: still refused, never expired.
        noteAssistantHost("env-mini", { hosts: true, at: LONG_AGO });
        mini.online = false;
        expect((yield* home.guardEnsure.pipe(Effect.flip)).detail).toContain(
          "take it back in Settings, Assistant",
        );
        expect(yield* liveAssistant).toBeUndefined();
        // The mini answers that it runs none: the archived copy comes back, no second one made.
        mini.online = true;
        miniHosts = false;
        yield* home.guardEnsure;
        expect((yield* liveAssistant)?.id).toBe("old-home");
      }),
    ),
  );

  it.effect("takes the Assistant back while its machine is gone; that machine yields later", () =>
    run(
      Effect.gen(function* () {
        yield* seedAssistant;
        const home = yield* AssistantHome;
        yield* home.manage({ action: "move", to: "env-mini" });
        // Online and running it: move it instead.
        expect((yield* home.manage({ action: "reclaim" }).pipe(Effect.flip)).detail).toContain(
          "Mac mini is online and runs your Assistant",
        );
        mini.online = false;
        const status = yield* home.manage({ action: "status" });
        expect(status.canReclaim).toBe(true);
        calls.length = 0;
        const after = yield* home.manage({ action: "reclaim" });
        expect(after.here).toBe(true);
        expect((yield* liveAssistant)?.id).toBe("old-home");
        expect(calls).toEqual([]);
        // The mini comes back: reconcile tells it to pause its copy, once.
        mini.online = true;
        yield* home.reconcile;
        expect(calls).toEqual(["assistant.yield"]);
        yield* home.reconcile;
        expect(calls).toEqual(["assistant.yield"]);
      }),
    ),
  );

  it.effect("yields its Assistant only to a machine that runs one", () =>
    run(
      Effect.gen(function* () {
        yield* seedAssistant;
        const home = yield* AssistantHome;
        const fromMini = { environmentId: "env-mini", label: "Mac mini" };
        expect((yield* home.yieldTo(fromMini).pipe(Effect.flip)).detail).toBe(
          "Mac mini does not run an Assistant, so the one here stays.",
        );
        expect((yield* liveAssistant)?.id).toBe("old-home");
        miniHosts = true;
        expect(yield* home.yieldTo(fromMini)).toEqual({ paused: true });
        expect(yield* liveAssistant).toBeUndefined();
        expect(dropped).toEqual(["old-assistant"]);
      }),
    ),
  );
  it.effect(
    "a host off for more than 3 days still blocks a second Assistant and offers take-back",
    () =>
      run(
        Effect.gen(function* () {
          // This machine never had the Assistant; the mini ran it and has been off a week.
          noteAssistantHost("env-mini", { hosts: true, at: LONG_AGO });
          mini.online = false;
          const home = yield* AssistantHome;
          expect((yield* home.guardEnsure.pipe(Effect.flip)).detail).toContain(
            "Your Assistant runs on Mac mini, which cannot be reached",
          );
          const status = yield* home.manage({ action: "status" });
          expect(status.elsewhere?.id).toBe("env-mini");
          expect(status.canReclaim).toBe(true);
          // Taking it back owes the mini a yield, then a client may create it here.
          yield* home.manage({ action: "reclaim" });
          yield* home.guardEnsure;
        }),
      ),
  );

  it.effect("runs Assistant schedules only once no linked machine runs it, or could", () =>
    run(
      Effect.gen(function* () {
        const home = yield* AssistantHome;
        // The mini says it runs the Assistant (it took it back while this machine slept).
        miniHosts = true;
        expect(yield* home.confirmHome).toEqual({
          ok: false,
          detail: "Mac mini runs your Assistant.",
        });
        // Unreachable, last heard running it: not confirmed.
        mini.online = false;
        expect((yield* home.confirmHome).ok).toBe(false);
        // Unreachable, last heard not running it: fine (an always-on home with a sleeping laptop).
        noteAssistantHost("env-mini", { hosts: false, at: 0 });
        expect(yield* home.confirmHome).toEqual({ ok: true });
      }),
    ),
  );

  it("fires the crash hook only from source, never from a bundled build", () => {
    expect(faultsAllowedFor("file:///repo/apps/server/src/reach/AssistantHome.ts")).toBe(true);
    expect(faultsAllowedFor("file:///Applications/Control Plane.app/server/dist/bin.mjs")).toBe(
      false,
    );
  });
  it.effect(
    "a linked machine that answers but cannot say no blocks schedules only if it last ran the Assistant",
    () =>
      run(
        Effect.gen(function* () {
          const home = yield* AssistantHome;
          // An older build without reach: it answers, with an error.
          describeError = "Unknown op: describe";
          noteAssistantHost("env-mini", { hosts: false, at: 0 });
          expect(yield* home.confirmHome).toEqual({ ok: true });
        }),
      ),
  );

  it.effect(
    "a token that needs relinking blocks schedules only if that machine last ran the Assistant",
    () =>
      run(
        Effect.gen(function* () {
          const home = yield* AssistantHome;
          describeError = "relink: the token was rejected";
          noteAssistantHost("env-mini", { hosts: true, at: 0 });
          expect((yield* home.confirmHome).ok).toBe(false);
        }),
      ),
  );

  it("decides which failed answers block the Assistant's schedules", () => {
    // Never answered (an older build, or never linked back): briefs still run.
    expect(blocksSchedules("refused", undefined)).toBe(false);
    expect(blocksSchedules("relink", undefined)).toBe(false);
    expect(blocksSchedules("refused", false)).toBe(false);
    expect(blocksSchedules("relink", true)).toBe(true);
    // No answer at all: blocked unless it last said no.
    expect(blocksSchedules("offline", undefined)).toBe(true);
    expect(blocksSchedules("timeout", true)).toBe(true);
    expect(blocksSchedules("offline", false)).toBe(false);
  });
});
