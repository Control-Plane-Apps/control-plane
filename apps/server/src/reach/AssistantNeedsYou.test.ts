import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationCommand,
  type ProjectStatus,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ReachHostDependencies } from "./ReachHost.ts";
import { make } from "./AssistantNeedsYou.ts";
import { makeScriptedReach } from "./testReach.ts";

const CODEX = ProviderInstanceId.make("codex");
const AT = "2026-11-21T09:00:00.000Z";
const ACME = ProjectId.make("acme");
const HOME = ProjectId.make("assistant-home");
const ACME_COORD = ThreadId.make("acme-coord");
const ASSISTANT = ThreadId.make("assistant");
const SELF = "env-macbook";
const QUESTION: ProjectStatus = {
  id: "question",
  title: "Approve",
  state: "needs-you",
  summary: "Waiting",
  updatedAt: AT,
  decision: { question: "Proceed?", recommendation: "Proceed", openedAt: AT },
};
let reachIds: string[] | null = null;
let oldPeer = false;
let peerSnapshotSequence = 10;
let peerProjectId: string = ACME;
let returned: ProjectStatus[] = [QUESTION];
let sent: unknown[] = [];
const peer = {
  id: "env-mini",
  label: "Mac mini",
  online: true,
  answer: (op: string, input: unknown) => {
    if (op === "overview")
      return {
        snapshotSequence: peerSnapshotSequence,
        projects: [
          {
            projectId: peerProjectId,
            title: "Remote Acme",
            coordinatorThreadId: "remote-coord",
            coordinatorPhase: "idle",
            needsYou: returned.map((status) => ({
              statusId: status.id,
              title: status.title,
              question: status.decision!.question,
              recommendation: status.decision!.recommendation,
              ...(!oldPeer ? { status } : {}),
            })),
            moving: [],
          },
        ],
        workspaces: [],
      };
    if (op === "status.list") return { statuses: returned };
    if (op === "status.reply") {
      sent.push(input);
      return { queued: true };
    }
    throw new Error(`unexpected ${op}`);
  },
};
const scripted = makeScriptedReach([peer]);
const TestLayer = ReachHostDependencies.pipe(
  Layer.provideMerge(scripted.layer),
  Layer.provideMerge(
    Layer.mock(ServerSettingsService)({
      getSettings: Effect.sync(() => ({
        ...DEFAULT_SERVER_SETTINGS,
        assistant: { ...DEFAULT_SERVER_SETTINGS.assistant, projects: reachIds },
      })),
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
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-reach-host-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

let counter = 0;
const cid = () => CommandId.make(`c-${(counter += 1)}`);
const dispatch = (command: OrchestrationCommand) =>
  Effect.flatMap(OrchestrationEngineService, (engine) => engine.dispatch(command));

/** A coordinated Project here, and optionally this machine's own Assistant. */
const seed = (withAssistant: boolean) =>
  Effect.gen(function* () {
    const projects: ReadonlyArray<readonly [ProjectId, ThreadId, string, "global" | undefined]> = [
      [ACME, ACME_COORD, "Acme", undefined],
      ...(withAssistant ? [[HOME, ASSISTANT, "Assistant", "global"] as const] : []),
    ];
    for (const [projectId, coord, title, scope] of projects) {
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

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.sync(() => {
    reachIds = null;
    oldPeer = false;
    peerSnapshotSequence = 10;
    peer.online = true;
    peer.id = "env-mini";
    peerProjectId = ACME;
    returned = [QUESTION];
    sent = [];
  }).pipe(Effect.andThen(seed(true)), Effect.andThen(effect), Effect.provide(TestLayer));

const askLocal = Effect.suspend(() =>
  dispatch({
    type: "project.status.set",
    commandId: cid(),
    projectId: ACME,
    actorThreadId: ACME_COORD,
    change: {
      kind: "upsert",
      id: QUESTION.id,
      title: QUESTION.title,
      state: QUESTION.state,
      summary: QUESTION.summary,
      question: QUESTION.decision!.question,
      recommendation: QUESTION.decision!.recommendation,
      answer: "Proceed",
    },
    createdAt: AT,
  }),
);
const reply = {
  environmentId: EnvironmentId.make(SELF),
  projectId: ACME,
  coordinatorThreadId: ACME_COORD,
  statusId: QUESTION.id,
  openedAt: AT,
  text: "Proceed, please",
};

describe("AssistantNeedsYou", () => {
  it.effect("aggregates a server-only Project and keeps identical local IDs separate", () =>
    run(
      Effect.gen(function* () {
        yield* askLocal;
        const service = yield* make;
        const result = yield* service.read;
        expect(result.items.map((item) => item.environmentId)).toEqual([SELF, peer.id]);
        expect(result.items.map((item) => item.projectId)).toEqual([ACME, ACME]);
      }),
    ),
  );
  it.effect("does not collapse different scoped IDs containing delimiters", () =>
    run(
      Effect.gen(function* () {
        const projectId = ProjectId.make("acme:project");
        const coordinator = ThreadId.make("colon-coordinator");
        yield* dispatch({
          type: "project.create",
          commandId: cid(),
          projectId,
          title: "Colon Project",
          workspaceRoot: "/tmp/colon-project",
          createdAt: AT,
        });
        yield* dispatch({
          type: "thread.create",
          commandId: cid(),
          threadId: coordinator,
          projectId,
          title: "Colon coordinator",
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
          assistant: { coordinatorThreadId: coordinator },
        });
        yield* dispatch({
          type: "project.status.set",
          commandId: cid(),
          projectId,
          actorThreadId: coordinator,
          change: {
            kind: "upsert",
            id: "question",
            title: "Approve",
            state: "needs-you",
            summary: "Waiting",
            question: "Proceed?",
            recommendation: "Proceed",
            answer: "Proceed",
          },
          createdAt: AT,
        });
        peer.id = `${SELF}:acme`;
        peerProjectId = "project";
        const service = yield* make;
        const result = yield* service.read;
        expect(result.items).toHaveLength(2);
        expect(result.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              environmentId: SELF,
              projectId,
              status: expect.objectContaining({ id: "question" }),
            }),
            expect.objectContaining({
              environmentId: peer.id,
              projectId: "project",
              status: expect.objectContaining({ id: "question" }),
            }),
          ]),
        );
      }),
    ),
  );
  it.effect("uses home reach and excludes answered, dismissed and off-state questions", () =>
    run(
      Effect.gen(function* () {
        reachIds = [];
        const service = yield* make;
        expect((yield* service.read).items).toEqual([]);
        reachIds = null;
        returned = [
          { ...QUESTION, decision: { ...QUESTION.decision!, answeredAt: AT } },
          { ...QUESTION, id: "dismissed", dismissedAt: AT },
          { ...QUESTION, id: "working", state: "working" },
        ];
        expect((yield* service.read).items).toEqual([]);
      }),
    ),
  );
  it.effect("retains last-known full questions as stale while a machine sleeps", () =>
    run(
      Effect.gen(function* () {
        const service = yield* make;
        yield* service.read;
        peer.online = false;
        const result = yield* service.read;
        expect(result.items).toHaveLength(1);
        expect(result.items[0]?.stale).toBe(true);
        expect(result.machines.find((machine) => machine.environmentId === peer.id)?.state).toBe(
          "offline",
        );
      }),
    ),
  );
  it.effect("refreshes stale Project questions and source versions when a peer answers again", () =>
    run(
      Effect.gen(function* () {
        peerProjectId = "control-plane";
        returned = [{ ...QUESTION, id: "assistant-tasks" }];
        const service = yield* make;
        yield* service.read;
        peer.online = false;
        const stale = yield* service.read;
        expect(stale.items.map((item) => [item.projectId, item.status.id, item.stale])).toEqual([
          ["control-plane", "assistant-tasks", true],
        ]);
        expect(
          stale.machines.find((machine) => machine.environmentId === peer.id)?.snapshotSequence,
        ).toBe(10);
        peer.online = true;
        peerSnapshotSequence = 30;
        peerProjectId = "hometrace";
        returned = [{ ...QUESTION, id: "inspection-follow-up" }];
        const recovered = yield* service.read;
        expect(recovered.items.map((item) => [item.projectId, item.status.id, item.stale])).toEqual(
          [["hometrace", "inspection-follow-up", false]],
        );
        expect(recovered.machines.find((machine) => machine.environmentId === peer.id)).toEqual(
          expect.objectContaining({ snapshotSequence: 30, state: "online" }),
        );
        peer.online = false;
        expect((yield* service.read).items.map((item) => item.projectId)).toEqual(["hometrace"]);
        peer.online = true;
        peerSnapshotSequence = 31;
        returned = [];
        expect((yield* service.read).items).toEqual([]);
        peer.online = false;
        const cleared = yield* service.read;
        expect(cleared.items).toEqual([]);
        expect(cleared.machines.find((machine) => machine.environmentId === peer.id)).toEqual(
          expect.objectContaining({ snapshotSequence: 31, state: "offline" }),
        );
      }),
    ),
  );
  it.effect("reads a full board on older peers before accepting a question revision", () =>
    run(
      Effect.gen(function* () {
        oldPeer = true;
        const service = yield* make;
        const result = yield* service.read;
        expect(result.items[0]?.status.decision.openedAt).toBe(AT);
        expect(scripted.calls.some((call) => call.op === "status.list")).toBe(true);
      }),
    ),
  );
  it.effect("preserves older-peer board snapshots offline", () =>
    run(
      Effect.gen(function* () {
        oldPeer = true;
        const service = yield* make;
        expect((yield* service.read).items).toHaveLength(1);
        peer.online = false;
        const result = yield* service.read;
        expect(result.items).toHaveLength(1);
        expect(result.items[0]?.stale).toBe(true);
        expect(result.machines.find((machine) => machine.environmentId === peer.id)?.state).toBe(
          "offline",
        );
      }),
    ),
  );
  it.effect("orders questions by deadline then question recency", () =>
    run(
      Effect.gen(function* () {
        returned = [
          QUESTION,
          {
            ...QUESTION,
            id: "due",
            decision: { ...QUESTION.decision!, deadline: "2026-11-22T00:00:00.000Z" },
          },
          {
            ...QUESTION,
            id: "new",
            decision: { ...QUESTION.decision!, openedAt: "2026-11-21T10:00:00.000Z" },
          },
        ];
        const service = yield* make;
        expect((yield* service.read).items.map((item) => item.status.id)).toEqual([
          "due",
          "new",
          "question",
        ]);
      }),
    ),
  );
  it.effect("routes an unconnected-server reply through a fresh verified reach op", () =>
    run(
      Effect.gen(function* () {
        const service = yield* make;
        const input = {
          ...reply,
          environmentId: EnvironmentId.make(peer.id),
          coordinatorThreadId: ThreadId.make("remote-coord"),
        };
        expect(yield* service.reply(input)).toEqual({ queued: true });
        expect(sent).toEqual([input]);
        expect(scripted.calls.at(-1)?.fresh).toBe(true);
        reachIds = [];
        const refusal = yield* service.reply(input).pipe(Effect.flip);
        expect(refusal.detail).toContain("outside");
        expect(sent).toHaveLength(1);
      }),
    ),
  );
  it.effect("appends a real version-checked user answer without an agent source", () =>
    run(
      Effect.gen(function* () {
        yield* askLocal;
        const service = yield* make;
        expect(yield* service.reply(reply)).toEqual({ queued: false });
        const messages = yield* (yield* ProjectionThreadMessageRepository).listByThreadId({
          threadId: ACME_COORD,
        });
        expect(messages).toHaveLength(1);
        expect(messages[0]?.source).toBeUndefined();
        expect(messages[0]?.text).toContain("[status:question@");
        const refusal = yield* service.reply(reply).pipe(Effect.flip);
        expect(refusal.detail).toContain("no longer needs");
        expect(
          yield* (yield* ProjectionThreadMessageRepository).listByThreadId({
            threadId: ACME_COORD,
          }),
        ).toHaveLength(1);
      }),
    ),
  );
  it.effect("holds the user's answer until a busy coordinator becomes idle", () =>
    run(
      Effect.gen(function* () {
        yield* askLocal;
        yield* dispatch({
          type: "thread.session.set",
          commandId: cid(),
          threadId: ACME_COORD,
          session: {
            threadId: ACME_COORD,
            status: "running",
            providerName: "codex",
            providerInstanceId: CODEX,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: AT,
          },
          createdAt: AT,
        });
        const service = yield* make;
        expect(yield* service.reply(reply)).toEqual({ queued: true });
        const messages = yield* (yield* ProjectionThreadMessageRepository).listByThreadId({
          threadId: ACME_COORD,
        });
        expect(messages).toHaveLength(1);
        expect(messages[0]?.source).toBeUndefined();
      }),
    ),
  );
  it.effect(
    "rejects stale revisions, wrong coordinators and unlinked environments without a message",
    () =>
      run(
        Effect.gen(function* () {
          yield* askLocal;
          const service = yield* make;
          for (const input of [
            { ...reply, openedAt: "2026-11-20T00:00:00.000Z" },
            { ...reply, coordinatorThreadId: ASSISTANT },
            { ...reply, environmentId: EnvironmentId.make("unknown") },
          ]) {
            yield* service.reply(input).pipe(Effect.flip);
          }
          expect(
            yield* (yield* ProjectionThreadMessageRepository).listByThreadId({
              threadId: ACME_COORD,
            }),
          ).toHaveLength(0);
        }),
      ),
  );
});
