import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  REACH_RESULT_ACTIVITY_KIND,
  ThreadId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { agentPushId } from "../orchestration/agentProtocol.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { make as makeReachHost, ReachHostDependencies } from "./ReachHost.ts";
import {
  ConfirmResult,
  AskResult,
  DescribeResult,
  OverviewResult,
  ResultsResult,
  ThreadFindResult,
  ThreadSendResult,
  type ReachOp,
} from "./reachProtocol.ts";
import { makeScriptedReach } from "./testReach.ts";
import { noteSent, reachInputHash } from "./reachSent.ts";

const CODEX = ProviderInstanceId.make("codex");
const AT = "2026-11-21T09:00:00.000Z";
const ACME = ProjectId.make("acme");
const HOME = ProjectId.make("assistant-home");
const ACME_COORD = ThreadId.make("acme-coord");
const ASSISTANT = ThreadId.make("assistant");
const SELF = "env-macbook";
const MINI = { environmentId: "env-mini", label: "Mac mini" };

let confirms = true;
const confirmsAsked: Array<unknown> = [];
// The Mac mini, as this server's own link reaches it: it vouches for its requests.
const scripted = makeScriptedReach([
  {
    id: "env-mini",
    label: "Mac mini",
    online: true,
    answer: (op, input) => {
      if (op === "confirm") {
        confirmsAsked.push(input);
        return { sent: confirms };
      }
      throw new Error(`unexpected ${op}`);
    },
  },
]);

const TestLayer = ReachHostDependencies.pipe(
  Layer.provideMerge(scripted.layer),
  Layer.provideMerge(
    Layer.mock(ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
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

let request = 0;
const call = <A, I>(
  op: ReachOp,
  input: unknown,
  result: Schema.Codec<A, I>,
  caller: { environmentId: string; label: string } = MINI,
  requestId = `req${(request += 1)}xyz`,
  subject: string | null = `agent-machine:${caller.environmentId}`,
) =>
  Effect.gen(function* () {
    const host = yield* makeReachHost;
    const response = yield* host.handle(
      {
        op,
        requestId,
        caller: { ...caller, threadId: "mini-assistant", threadTitle: "Assistant" },
        input,
      },
      subject === null ? undefined : { subject },
    );
    if (!response.ok) return { ok: false as const, error: response.error };
    return {
      ok: true as const,
      value: yield* Schema.decodeUnknownEffect(result)(response.result).pipe(Effect.orDie),
    };
  });

const run = <A, E, R>(effect: Effect.Effect<A, E, R>, withAssistant = false) =>
  Effect.sync(() => void (confirms = true)).pipe(
    Effect.andThen(seed(withAssistant)),
    Effect.andThen(effect),
    Effect.provide(TestLayer),
  );

describe("ReachHost", () => {
  it.effect("refuses a call from its own environment", () =>
    run(
      Effect.gen(function* () {
        const result = yield* call("describe", {}, DescribeResult, {
          environmentId: SELF,
          label: "MacBook",
        });
        expect(result).toEqual({ ok: false, error: "A machine cannot reach itself." });
      }),
    ),
  );

  it.effect("describes the machine and its Assistant", () =>
    run(
      Effect.gen(function* () {
        const result = yield* call("describe", {}, DescribeResult);
        expect(result).toEqual({
          ok: true,
          value: {
            environmentId: SELF,
            label: "MacBook",
            assistant: { threadId: ASSISTANT, projectId: HOME },
            linked: ["env-mini"],
          },
        });
      }),
      true,
    ),
  );

  it.effect("lists its Projects for the overview, never a global Assistant", () =>
    run(
      Effect.gen(function* () {
        const result = yield* call("overview", {}, OverviewResult);
        expect(result.ok && result.value.projects.map((project) => project.title)).toEqual([
          "Acme",
        ]);
      }),
      true,
    ),
  );

  it.effect("holds an ask for the coordinator with a reach id and the remote replyTo", () =>
    run(
      Effect.gen(function* () {
        const result = yield* call(
          "ask",
          { askId: "abc123def456", projectId: ACME, question: "What is blocked?" },
          AskResult,
        );
        if (!result.ok) throw new Error(result.error);
        expect(result.value.coordinatorThreadId).toBe(ACME_COORD);
        expect(result.value.messageId).toMatch(/^cp-send:acme-coord:ask:abc123def456:reach:/);
        const messages = yield* (yield* ProjectionThreadMessageRepository).listByThreadId({
          threadId: ACME_COORD,
        });
        const held = messages.find((message) => message.messageId === result.value.messageId);
        expect(held?.source).toEqual({
          kind: "agent",
          threadId: "mini-assistant",
          threadTitle: "Assistant (on Mac mini)",
          replyTo: "mini-assistant",
        });
      }),
    ),
  );

  it.effect("returns a kept answer, and reports a request whose thread is gone as lost", () =>
    run(
      Effect.gen(function* () {
        const messageId = `cp-send:${ACME_COORD}:ask:abc123def456:reach:r1`;
        const pushId = agentPushId(ACME_COORD, messageId);
        yield* dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(pushId),
          threadId: ACME_COORD,
          activity: {
            id: EventId.make(pushId),
            tone: "info",
            kind: REACH_RESULT_ACTIVITY_KIND,
            summary: "Answer sent",
            payload: { detail: "", replyTo: "mini-assistant", text: "Nothing is blocked." },
            turnId: null,
            createdAt: AT,
          },
          createdAt: AT,
        });
        const result = yield* call(
          "results",
          {
            requests: [
              { threadId: ACME_COORD, messageId },
              { threadId: ACME_COORD, messageId: "cp-send:acme-coord:pending" },
              { threadId: "gone-coord", messageId: "cp-send:gone-coord:x" },
            ],
          },
          ResultsResult,
        );
        expect(result).toEqual({
          ok: true,
          value: {
            results: [
              { threadId: ACME_COORD, messageId, threadTitle: "Acme", text: "Nothing is blocked." },
            ],
            lost: [{ threadId: "gone-coord", messageId: "cp-send:gone-coord:x" }],
          },
        });
      }),
    ),
  );

  it.effect("writes Status as the remote Assistant and notes the coordinator", () =>
    run(
      Effect.gen(function* () {
        const result = yield* call(
          "status.set",
          {
            projectId: ACME,
            note: true,
            input: { id: "payouts", title: "Payouts", state: "working", summary: "Running" },
          },
          Schema.Unknown,
        );
        expect(result.ok).toBe(true);
        const row = yield* (yield* ProjectionProjectRepository).getById({ projectId: ACME });
        const statuses = row._tag === "Some" ? (row.value.assistant?.statuses ?? []) : [];
        expect(statuses.map((status) => status.title)).toEqual(["Payouts"]);
        const messages = yield* (yield* ProjectionThreadMessageRepository).listByThreadId({
          threadId: ACME_COORD,
        });
        expect(messages.some((message) => message.messageId.includes("status-note:"))).toBe(true);
      }),
    ),
  );

  it.effect("refuses a remote Status write whose actor does not match", () =>
    run(
      Effect.gen(function* () {
        const outcome = yield* dispatch({
          type: "project.status.set",
          commandId: cid(),
          projectId: ACME,
          actorThreadId: ThreadId.make("someone-else"),
          remoteActor: { ...MINI, threadId: ThreadId.make("mini-assistant") },
          change: { kind: "upsert", id: "x", title: "X", state: "queued", summary: "s" },
          createdAt: AT,
        }).pipe(Effect.result);
        expect(outcome._tag).toBe("Failure");
      }),
    ),
  );

  it.effect("finds the Assistant by name and sends it a held note", () =>
    run(
      Effect.gen(function* () {
        const found = yield* call("thread.find", { ref: "assistant" }, ThreadFindResult);
        expect(found).toEqual({
          ok: true,
          value: { matches: [{ threadId: ASSISTANT, title: "Assistant" }] },
        });
        const note = yield* call(
          "assistant.note",
          { kind: "ping", text: "Deploy is stuck", projectTitle: "Acme" },
          ThreadSendResult,
        );
        expect(note.ok && note.value.threadId).toBe(ASSISTANT);
        const messages = yield* (yield* ProjectionThreadMessageRepository).listByThreadId({
          threadId: ASSISTANT,
        });
        expect(messages.at(-1)?.text).toContain("The Acme coordinator (on Mac mini)");
        expect(messages.at(-1)?.text).toContain("Deploy is stuck");
      }),
      true,
    ),
  );

  it.effect("sends a thread message and a task handoff as held sends", () =>
    run(
      Effect.gen(function* () {
        const sent = yield* call(
          "thread.send",
          { threadId: ACME_COORD, message: "Ship it" },
          ThreadSendResult,
        );
        expect(sent).toEqual({
          ok: true,
          value: { threadId: ACME_COORD, threadTitle: "Acme", queued: false },
        });
        const handed = yield* call(
          "task.deliver",
          { threadId: ACME_COORD, text: "Task handoff: renew the domain" },
          ThreadSendResult,
        );
        expect(handed.ok).toBe(true);
        const missing = yield* call(
          "thread.send",
          { threadId: "nope", message: "Hi" },
          ThreadSendResult,
        );
        expect(missing).toEqual({
          ok: false,
          error: "There is no live thread 'nope' on this machine.",
        });
      }),
    ),
  );

  it.effect("manages a Project's schedules for the remote Assistant", () =>
    run(
      Effect.gen(function* () {
        const created = yield* call(
          "schedule.create",
          {
            projectId: ACME,
            input: { name: "Standup", prompt: "Post standup", cron: "0 9 * * 1-5" },
          },
          Schema.Struct({ id: Schema.String, enabled: Schema.Boolean }),
        );
        if (!created.ok) throw new Error(created.error);
        expect(created.value.enabled).toBe(false);
        const turnedOn = yield* call(
          "schedule.update",
          { projectId: ACME, input: { id: created.value.id, enabled: true } },
          Schema.Unknown,
        );
        // The Assistant's server did not vouch for a user turn: refused.
        expect(turnedOn.ok).toBe(false);
        const listed = yield* call(
          "schedule.list",
          { projectId: ACME, input: {} },
          Schema.Struct({ schedules: Schema.Array(Schema.Struct({ name: Schema.String })) }),
        );
        expect(listed.ok && listed.value.schedules.map((entry) => entry.name)).toEqual(["Standup"]);
      }),
    ),
  );

  it.effect("runs a write only for a caller its own link can confirm", () =>
    run(
      Effect.gen(function* () {
        const stranger = yield* call(
          "thread.send",
          { threadId: ACME_COORD, message: "hi" },
          ThreadSendResult,
          { environmentId: "env-stranger", label: "Stranger" },
        );
        expect(stranger.ok).toBe(false);
        expect(!stranger.ok && stranger.error).toContain(
          'use Settings, Connections, Agent machines, Add machine with "Let that machine reach this one too" on',
        );
        confirms = false;
        const forged = yield* call(
          "thread.send",
          { threadId: ACME_COORD, message: "hi" },
          ThreadSendResult,
        );
        expect(forged).toEqual({
          ok: false,
          error: "Mac mini did not send this request, so nothing was done.",
        });
        // Reads need no confirmation.
        const read = yield* call("overview", {}, OverviewResult, {
          environmentId: "env-stranger",
          label: "Stranger",
        });
        expect(read.ok).toBe(true);
      }),
    ),
  );

  it.effect("asks to confirm the exact request, and accepts each id once", () =>
    run(
      Effect.gen(function* () {
        confirmsAsked.length = 0;
        const input = { threadId: ACME_COORD, message: "hi" };
        const first = yield* call("thread.send", input, ThreadSendResult, MINI, "replay123");
        expect(first.ok).toBe(true);
        expect(confirmsAsked).toEqual([
          {
            requestId: "replay123",
            op: "thread.send",
            inputHash: reachInputHash(input),
            receiver: SELF,
          },
        ]);
        // The same id again, even with the same op and input, is refused without asking.
        const again = yield* call("thread.send", input, ThreadSendResult, MINI, "replay123");
        expect(again).toEqual({ ok: false, error: "This request was already used." });
        // The confirmation never reuses a recent "offline" verdict for the caller.
        expect(scripted.calls.findLast((entry) => entry.op === "confirm")?.fresh).toBe(true);
        expect(confirmsAsked).toHaveLength(1);
      }),
    ),
  );

  it.effect(
    "a request that could not be confirmed is not spent, so it can be confirmed again",
    () =>
      run(
        Effect.gen(function* () {
          confirmsAsked.length = 0;
          const input = { threadId: ACME_COORD, message: "hi" };
          confirms = false;
          const refused = yield* call("thread.send", input, ThreadSendResult, MINI, "retry1234");
          expect(refused.ok).toBe(false);
          confirms = true;
          const accepted = yield* call("thread.send", input, ThreadSendResult, MINI, "retry1234");
          expect(accepted.ok).toBe(true);
          expect(confirmsAsked).toHaveLength(2);
        }),
      ),
  );

  it.effect("a token tagged for one machine cannot speak for another", () =>
    run(
      Effect.gen(function* () {
        const input = { threadId: ACME_COORD, message: "hi" };
        const spoofed = yield* call(
          "thread.send",
          input,
          ThreadSendResult,
          MINI,
          "spoof12345",
          "agent-machine:env-other",
        );
        expect(spoofed).toEqual({ ok: false, error: "This link belongs to another machine." });
      }),
    ),
  );

  it.effect("link back needs a token tagged for the machine asking", () =>
    run(
      Effect.gen(function* () {
        const untagged = yield* call(
          "link.back",
          { pairingUrl: "http://127.0.0.1:47799/pair#token=ABCDEF123456" },
          Schema.Unknown,
          { environmentId: "env-new", label: "New Mac" },
          "linkback1",
          "agent-machine-link",
        );
        expect(untagged.ok).toBe(false);
        if (!untagged.ok) expect(untagged.error).toContain("tagged for the machine asking");
      }),
    ),
  );

  it.effect("confirms only requests this machine sent to the machine asking", () =>
    run(
      Effect.gen(function* () {
        noteSent({ requestId: "sent1", op: "status.set", inputHash: "h", receiver: "env-mini" }, 0);
        const asked = (receiver: string) =>
          call(
            "confirm",
            { requestId: "sent1", op: "status.set", inputHash: "h", receiver },
            ConfirmResult,
          );
        // The Mac mini asks about a request this machine sent it: yes.
        expect(yield* asked("env-mini")).toEqual({ ok: true, value: { sent: true } });
        // Another machine relaying it, or a mismatched receiver, gets no.
        expect(
          yield* call(
            "confirm",
            { requestId: "sent1", op: "status.set", inputHash: "h", receiver: "env-mini" },
            ConfirmResult,
            { environmentId: "env-stranger", label: "Stranger" },
          ),
        ).toEqual({ ok: true, value: { sent: false } });
        expect(yield* asked("env-stranger")).toEqual({ ok: true, value: { sent: false } });
      }),
    ),
  );

  it.effect("refuses an unknown Project", () =>
    run(
      Effect.gen(function* () {
        const result = yield* call("status.list", { projectId: "nope" }, Schema.Unknown);
        expect(result).toEqual({ ok: false, error: "'nope' is not a Project on this machine." });
      }),
    ),
  );
});
