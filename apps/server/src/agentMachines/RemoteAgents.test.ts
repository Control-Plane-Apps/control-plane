import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { PeerError } from "./AgentMachineClient.ts";
import { agentCreateIds } from "../orchestration/agentProtocol.ts";
import { RemoteAgents, RemoteAgentsLive, type CreateRemoteInput } from "./RemoteAgents.ts";
import { RemoteAgentStore } from "./RemoteAgentStore.ts";
import {
  MemoryRemoteAgentStore,
  TEST_NOW,
  makeFakePeer,
  makePeerThread,
  makeRecord,
  type FakePeerOptions,
} from "./testFixtures.ts";

const ids = agentCreateIds("coordinator", "request-1");

const createInput = (overrides: Partial<CreateRemoteInput> = {}): CreateRemoteInput => ({
  machineId: "mini",
  machineLabel: "Mac Mini",
  peerProjectId: "peer-project",
  home: {
    project: { id: "project-1", title: "Acme", workspaceRoot: "/work/acme" },
    label: "This Mac",
  },
  creator: { id: "coordinator", title: "Acme" },
  ids,
  threadId: "remote-1",
  title: "Pricing",
  message: "Compare plans.",
  runtimeMode: "approval-required",
  baseModel: { instanceId: "codex" as never, model: "gpt-5.4" },
  requestedModel: undefined,
  createdAt: TEST_NOW,
  ...overrides,
});

const harness = (options?: FakePeerOptions) => {
  const peer = makeFakePeer(options);
  const layer = RemoteAgentsLive.pipe(
    Layer.provideMerge(peer.layer),
    Layer.provideMerge(MemoryRemoteAgentStore),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, RemoteAgents | RemoteAgentStore>) =>
    effect.pipe(Effect.provide(layer));
  return { peer, run };
};

describe("RemoteAgents.reserve and start", () => {
  it.effect("creates the peer thread and sends the first message with no creator or replyTo", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      const record = yield* run(
        Effect.gen(function* () {
          const remote = yield* RemoteAgents;
          const reserved = yield* remote.reserve(createInput());
          expect(reserved.existed).toBe(false);
          expect(reserved.record.state).toBe("pending");
          return yield* remote.start(createInput(), reserved.record);
        }),
      );

      expect(peer.commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
      ]);
      const [create, start] = peer.commands;
      expect(create).toMatchObject({
        commandId: ids.createCommandId,
        threadId: "remote-1",
        projectId: "peer-project",
        title: "Pricing",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
      });
      expect(create).not.toHaveProperty("createdByThreadId");
      expect(start?.type === "thread.turn.start" && start.message.source).toEqual({
        kind: "agent",
        threadId: "coordinator",
        threadTitle: "Acme",
      });
      if (start?.type === "thread.turn.start") {
        expect(start.message.messageId).toBe(ids.messageId);
        expect(start.message.text).toContain("You are running on Mac Mini");
        expect(start.message.text).toContain("Compare plans.");
        expect(start.runtimeMode).toBe("approval-required");
      }
      expect(record.state).toBe("open");
      expect(record.inFlight).toMatchObject({
        messageId: ids.messageId,
        replyTo: "coordinator",
        baselineTurnId: null,
        suppressed: false,
      });
    }),
  );

  it.effect("only releases an explicitly undispatched reservation after a failed probe", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      yield* run(
        Effect.gen(function* () {
          const remote = yield* RemoteAgents;
          const store = yield* RemoteAgentStore;
          const input = createInput();
          const fresh = (yield* remote.reserve(input)).record;
          expect(fresh.createAttempted).toBe(false);
          peer.state.reachable = false;
          expect((yield* Effect.flip(remote.start(input, fresh))).stage).toBe("create");
          expect(Option.isNone(yield* store.get(input.threadId))).toBe(true);
          const legacy = makeRecord({ state: "pending", inFlight: null });
          yield* store.put(legacy);
          expect((yield* Effect.flip(remote.start(input, legacy))).stage).toBe("start");
          expect(Option.getOrThrow(yield* store.get(input.threadId))).toEqual(legacy);
          peer.state.reachable = true;
          const retried = yield* remote.reserve(input);
          expect(retried.existed).toBe(true);
          expect((yield* remote.start(input, retried.record)).state).toBe("open");
        }),
      );
    }),
  );

  it.effect("creates with the provider instance and model resolved by the destination", () =>
    Effect.gen(function* () {
      const { peer, run } = harness({
        resolveModel: () =>
          Effect.succeed({ instanceId: "destination-provider" as never, model: "canonical-slug" }),
      });
      yield* run(
        Effect.gen(function* () {
          const remote = yield* RemoteAgents;
          const reserved = yield* remote.reserve(createInput({ requestedModel: "gpt-5.4-mini" }));
          yield* remote.start(createInput({ requestedModel: "gpt-5.4-mini" }), reserved.record);
        }),
      );
      expect(peer.commands[0]).toMatchObject({
        modelSelection: { instanceId: "destination-provider", model: "canonical-slug" },
      });
    }),
  );

  it.effect("keeps the original placement when create acknowledgement is ambiguous", () =>
    Effect.gen(function* () {
      const { peer, run } = harness({ failOn: ["thread.create"] });
      const outcome = yield* run(
        Effect.gen(function* () {
          const remote = yield* RemoteAgents;
          const store = yield* RemoteAgentStore;
          const reserved = yield* remote.reserve(createInput());
          const failure = yield* Effect.flip(remote.start(createInput(), reserved.record));
          return { failure, left: yield* store.list };
        }),
      );
      expect(outcome.failure.stage).toBe("start");
      expect(outcome.left).toMatchObject([{ machineId: "mini", createAttempted: true }]);
      expect(peer.commands).toEqual([]);
    }),
  );

  it.effect(
    "keeps the record pending when only the first message failed, and a retry finishes it",
    () =>
      Effect.gen(function* () {
        const { peer, run } = harness({ failOn: ["thread.turn.start"] });
        const result = yield* run(
          Effect.gen(function* () {
            const remote = yield* RemoteAgents;
            const store = yield* RemoteAgentStore;
            const reserved = yield* remote.reserve(createInput());
            const failure = yield* Effect.flip(remote.start(createInput(), reserved.record));
            const pending = yield* store.get("remote-1");
            return { failure, pending };
          }),
        );
        expect(result.failure.stage).toBe("start");
        expect(Option.getOrThrow(result.pending).state).toBe("pending");

        // The same ids on a healthy peer: reserve finds the record, start sends again.
        const retry = harness();
        const finished = yield* retry.run(
          Effect.gen(function* () {
            const remote = yield* RemoteAgents;
            const store = yield* RemoteAgentStore;
            yield* store.put(Option.getOrThrow(result.pending));
            const again = yield* remote.reserve(createInput());
            expect(again.existed).toBe(true);
            return yield* remote.start(createInput(), again.record);
          }),
        );
        expect(finished.state).toBe("open");
        expect(peer.commands.map((command) => command.type)).toEqual(["thread.create"]);
      }),
  );

  it.effect(
    "returns an open record with a request in flight as it is (a retry after a landed start)",
    () =>
      Effect.gen(function* () {
        const { peer, run } = harness();
        const record = makeRecord({
          state: "open",
          inFlight: {
            messageId: "cp-agent-message:x",
            replyTo: "coordinator",
            sentAt: TEST_NOW,
            baselineTurnId: null,
            suppressed: false,
          },
        });
        const result = yield* run(
          Effect.gen(function* () {
            const remote = yield* RemoteAgents;
            return yield* remote.start(createInput(), record);
          }),
        );
        expect(result).toEqual(record);
        expect(peer.commands).toEqual([]);
      }),
  );
});

describe("RemoteAgents.openCount, find, list", () => {
  it.effect("counts pending agents and open agents with a request in flight, per Project", () =>
    Effect.gen(function* () {
      const { run } = harness();
      const inFlight = {
        messageId: "m",
        replyTo: "coordinator",
        sentAt: TEST_NOW,
        baselineTurnId: null,
        suppressed: false,
      };
      const counts = yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          yield* store.put(makeRecord({ threadId: "a", state: "pending" }));
          yield* store.put(makeRecord({ threadId: "b", state: "open", inFlight }));
          yield* store.put(makeRecord({ threadId: "c", state: "open", inFlight: null }));
          yield* store.put(makeRecord({ threadId: "d", state: "settled" }));
          yield* store.put(makeRecord({ threadId: "e", state: "lost", inFlight }));
          yield* store.put(
            makeRecord({ threadId: "f", state: "pending", homeProjectId: "project-2" }),
          );
          return {
            first: yield* remote.openCount("project-1"),
            other: yield* remote.openCount("project-2"),
          };
        }),
      );
      expect(counts).toEqual({ first: 2, other: 1 });
    }),
  );

  it.effect("finds by id in any Project and by title only in the given Project", () =>
    Effect.gen(function* () {
      const { run } = harness();
      const found = yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          yield* store.put(makeRecord({ threadId: "a", title: "Pricing" }));
          yield* store.put(
            makeRecord({ threadId: "b", title: "Pricing", homeProjectId: "project-2" }),
          );
          return {
            byId: yield* remote.find({ projectId: "project-1", ref: "b" }),
            byTitle: yield* remote.find({ projectId: "project-1", ref: " pricing " }),
          };
        }),
      );
      expect(found.byId.map((record) => record.threadId)).toEqual(["b"]);
      expect(found.byTitle.map((record) => record.threadId)).toEqual(["a"]);
    }),
  );

  it.effect("lists an open agent as stale while its machine is unreachable", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      peer.state.reachable = false;
      const listed = yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          yield* store.put(makeRecord({ threadId: "a", lastPhase: "running" }));
          yield* store.put(makeRecord({ threadId: "b", state: "settled", lastPhase: "completed" }));
          return yield* remote.list("project-1");
        }),
      );
      expect(listed.map((entry) => [entry.record.threadId, entry.phase])).toEqual([
        ["a", "stale"],
        ["b", "completed"],
      ]);
    }),
  );
});

describe("RemoteAgents.read", () => {
  it.effect("maps the peer's messages to requests and results", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      peer.threads.set(
        "remote-1",
        makePeerThread("remote-1", {
          latestTurn: {
            turnId: "turn-1" as never,
            state: "completed",
            requestedAt: TEST_NOW,
            startedAt: TEST_NOW,
            completedAt: TEST_NOW,
            assistantMessageId: null,
          },
        }),
      );
      peer.details.set("remote-1", {
        messages: [
          { id: "m1", role: "user", text: "Compare plans.", streaming: false },
          { id: "m2", role: "assistant", text: "Plan B wins.", streaming: false },
        ] as never,
      });
      const read = yield* run(
        Effect.gen(function* () {
          const remote = yield* RemoteAgents;
          return yield* remote.read(makeRecord(), 1);
        }),
      );
      expect(read.turns).toEqual([
        { state: "completed", request: "Compare plans.", result: "Plan B wins." },
      ]);
      expect(read.phase).toBe("completed");
    }),
  );

  it.effect("says so when the peer thread is gone", () =>
    Effect.gen(function* () {
      const { run } = harness();
      const failure = yield* run(
        Effect.gen(function* () {
          const remote = yield* RemoteAgents;
          return yield* Effect.flip(remote.read(makeRecord(), 1));
        }),
      );
      expect(failure.detail).toContain("no longer on Mac Mini");
    }),
  );

  it.effect("names the machine when it cannot be reached", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      peer.state.reachable = false;
      const failure = yield* run(
        Effect.gen(function* () {
          const remote = yield* RemoteAgents;
          return yield* Effect.flip(remote.read(makeRecord(), 1));
        }),
      );
      expect(failure.detail).toContain("Could not reach Mac Mini");
    }),
  );
});

describe("RemoteAgents.stop", () => {
  const inFlight = {
    messageId: "m",
    replyTo: "coordinator",
    sentAt: TEST_NOW,
    baselineTurnId: null,
    suppressed: false,
  };

  it.effect("suppresses the result first, interrupts a working agent, and stops its session", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      const outcome = yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          yield* store.put(
            makeRecord({
              inFlight,
              queuedSends: [
                { messageId: "q", text: "later", replyTo: "coordinator", queuedAt: TEST_NOW },
              ],
            }),
          );
          const stopped = yield* remote.stop(
            makeRecord({
              inFlight,
              queuedSends: [
                { messageId: "q", text: "later", replyTo: "coordinator", queuedAt: TEST_NOW },
              ],
            }),
            { archive: false },
          );
          return { stopped, record: Option.getOrThrow(yield* store.get("remote-1")) };
        }),
      );
      expect(outcome.stopped).toEqual({ stopped: true, archived: false });
      expect(peer.commands.map((command) => command.type)).toEqual([
        "thread.turn.interrupt",
        "thread.session.stop",
      ]);
      expect(outcome.record.inFlight).toBeNull();
      expect(outcome.record.queuedSends).toEqual([]);
    }),
  );

  it.effect("retains the queue and baseline until stop is acknowledged", () =>
    Effect.gen(function* () {
      const { run } = harness({ failOn: ["thread.session.stop"] });
      yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          const record = makeRecord({
            inFlight,
            queuedSends: [
              { messageId: "q", text: "later", replyTo: "manager", queuedAt: TEST_NOW },
            ],
          });
          yield* store.put(record);
          yield* Effect.flip(remote.stop(record, { archive: false }));
          const saved = Option.getOrThrow(yield* store.get(record.threadId));
          expect(saved.queuedSends).toEqual(record.queuedSends);
          expect(saved.inFlight).toEqual(inFlight);
          expect(saved.stoppingAt).toBeTruthy();
        }),
      );
    }),
  );

  it.effect("does not interrupt an idle agent, and reports nothing was stopped", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      const stopped = yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          yield* store.put(makeRecord());
          return yield* remote.stop(makeRecord(), { archive: false });
        }),
      );
      expect(stopped.stopped).toBe(false);
      expect(peer.commands.map((command) => command.type)).toEqual(["thread.session.stop"]);
    }),
  );

  it.effect("archives on request and settles the record", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      const record = yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          yield* store.put(makeRecord());
          yield* remote.stop(makeRecord(), { archive: true });
          return Option.getOrThrow(yield* store.get("remote-1"));
        }),
      );
      expect(peer.commands.map((command) => command.type)).toEqual([
        "thread.session.stop",
        "thread.archive",
      ]);
      expect(record.state).toBe("settled");
      expect(record.endedAt).not.toBeNull();
    }),
  );
});

describe("RemoteAgents.send and startQueued", () => {
  const sender = { id: "coordinator", title: "Acme" };

  it.effect(
    "starts a turn on an idle agent, recording the turn before the send as the baseline",
    () =>
      Effect.gen(function* () {
        const { peer, run } = harness();
        peer.threads.set(
          "remote-1",
          makePeerThread("remote-1", {
            latestTurn: {
              turnId: "turn-1" as never,
              state: "completed",
              requestedAt: TEST_NOW,
              startedAt: TEST_NOW,
              completedAt: TEST_NOW,
              assistantMessageId: null,
            },
          }),
        );
        const outcome = yield* run(
          Effect.gen(function* () {
            const store = yield* RemoteAgentStore;
            const remote = yield* RemoteAgents;
            yield* store.put(makeRecord({ state: "settled", endedAt: TEST_NOW }));
            const sent = yield* remote.send(makeRecord(), {
              text: "Also compare annual pricing.",
              sender,
              replyTo: "coordinator",
              runtimeMode: "approval-required",
            });
            return { sent, record: Option.getOrThrow(yield* store.get("remote-1")) };
          }),
        );
        expect(outcome.sent).toEqual({ queued: false });
        expect(peer.commands.map((command) => command.type)).toEqual(["thread.turn.start"]);
        const start = peer.commands[0];
        expect(start?.type === "thread.turn.start" && start.message.messageId).toMatch(
          /^cp-remote-send:remote-1:/,
        );
        expect(outcome.record.state).toBe("open");
        expect(outcome.record.inFlight?.baselineTurnId).toBe("turn-1");
      }),
  );

  it.effect("deduplicates linked deliveries across a retry and enforces the sender budget", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      peer.threads.set("remote-1", makePeerThread("remote-1"));
      yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          const record = makeRecord();
          yield* store.put(record);
          const send = (text: string) =>
            remote.send(record, {
              text,
              sender,
              peer: true,
              replyTo: null,
              runtimeMode: "approval-required",
            });
          const original = yield* send("one");
          const duplicate = yield* send("one");
          expect(duplicate).toMatchObject({ duplicate: true, messageId: original.messageId });
          for (const text of ["two", "three", "four"]) yield* send(text);
          expect((yield* Effect.flip(send("five"))).detail).toContain("budget exhausted");
          expect(peer.commands).toHaveLength(1);
        }),
      );
    }),
  );

  it.effect("persists a refused peer receipt and lets the next queued message run", () =>
    Effect.gen(function* () {
      const { peer, run } = harness({
        dispatchFailure: (command) =>
          command.type === "thread.turn.start" && command.message.text === "first"
            ? new PeerError({
                kind: "rejected",
                code: "command_refused",
                detail: "Command refused",
              })
            : undefined,
      });
      const view = makePeerThread("remote-1");
      peer.threads.set(view.id, view);
      yield* run(
        Effect.gen(function* () {
          const remote = yield* RemoteAgents;
          const store = yield* RemoteAgentStore;
          const record = makeRecord({
            inFlight: {
              messageId: "busy",
              replyTo: sender.id,
              sentAt: TEST_NOW,
              baselineTurnId: null,
              suppressed: false,
            },
          });
          yield* store.put(record);
          const send = (text: string) =>
            remote.send(record, {
              text,
              sender,
              peer: true,
              receiptId: text,
              replyTo: null,
              runtimeMode: record.runtimeMode,
            });
          const first = yield* send("first");
          const second = yield* send("second");
          const idle = Option.getOrThrow(
            yield* store.update(record.threadId, (current) => ({ ...current, inFlight: null })),
          );
          const refused = yield* Effect.flip(remote.startQueued(idle, view));
          const saved = Option.getOrThrow(yield* store.get(record.threadId));
          expect(saved.queuedSends.map((item) => item.messageId)).toEqual([second.messageId]);
          expect(saved.refusedPeerMessages).toEqual({ [String(first.messageId)]: refused.detail });
          yield* remote.startQueued(saved, view);
          peer.state.reachable = false;
          expect((yield* Effect.flip(send("first"))).detail).toBe(refused.detail);
          expect(peer.commands).toHaveLength(1);
        }),
      );
    }),
  );

  it.effect(
    "keeps a peer message queued with the same ID after opaque and transport failures",
    () =>
      Effect.gen(function* () {
        const failures = [
          new PeerError({ kind: "rejected", detail: "Opaque server error" }),
          new PeerError({ kind: "timeout", detail: "No acknowledgement" }),
        ];
        const attempted: string[] = [];
        const { peer, run } = harness({
          dispatchFailure: (command) => {
            attempted.push(command.commandId);
            return failures.shift();
          },
        });
        const view = makePeerThread("remote-1");
        peer.threads.set(view.id, view);
        yield* run(
          Effect.gen(function* () {
            const remote = yield* RemoteAgents;
            const store = yield* RemoteAgentStore;
            const record = makeRecord();
            yield* store.put(record);
            const send = remote.send(record, {
              text: "message",
              sender,
              peer: true,
              receiptId: "retry",
              replyTo: null,
              runtimeMode: record.runtimeMode,
            });
            yield* Effect.flip(send);
            const pending = Option.getOrThrow(yield* store.get(record.threadId));
            expect(pending.queuedSends).toHaveLength(1);
            expect(pending.refusedPeerMessages).toBeUndefined();
            yield* Effect.flip(remote.startQueued(pending, view));
            expect(yield* send).toMatchObject({ duplicate: true, queued: true });
            yield* remote.startQueued(pending, view);
            const accepted = Option.getOrThrow(yield* store.get(record.threadId));
            expect(accepted.queuedSends).toEqual([]);
            expect(attempted).toEqual(Array(3).fill(accepted.inFlight?.messageId));
          }),
        );
      }),
  );

  it.effect("recovers the pre-dispatch baseline when an acknowledgement was lost", () =>
    Effect.gen(function* () {
      const queued = makeRecord({
        queuedSends: [{ messageId: "q", text: "next", replyTo: "coordinator", queuedAt: TEST_NOW }],
      });
      const failed = harness({ failOn: ["thread.turn.start"] });
      const pending = yield* failed.run(
        Effect.gen(function* () {
          const remote = yield* RemoteAgents;
          const store = yield* RemoteAgentStore;
          yield* store.put(queued);
          yield* Effect.flip(remote.startQueued(queued, makePeerThread("remote-1")));
          return Option.getOrThrow(yield* store.get(queued.threadId));
        }),
      );
      expect(pending.queuedSends[0]?.baselineTurnId).toBeNull();
      const retry = harness();
      yield* retry.run(
        Effect.gen(function* () {
          const remote = yield* RemoteAgents;
          const store = yield* RemoteAgentStore;
          yield* store.put(pending);
          yield* remote.startQueued(
            pending,
            makePeerThread("remote-1", {
              latestTurn: {
                turnId: "already-landed" as never,
                state: "completed",
                requestedAt: TEST_NOW,
                startedAt: TEST_NOW,
                completedAt: TEST_NOW,
                assistantMessageId: null,
              },
            }),
          );
          expect(
            Option.getOrThrow(yield* store.get(queued.threadId)).inFlight?.baselineTurnId,
          ).toBeNull();
        }),
      );
    }),
  );

  it.effect("queues a send while a request is in flight, and sends nothing", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      peer.threads.set("remote-1", makePeerThread("remote-1"));
      const inFlightRecord = makeRecord({
        inFlight: {
          messageId: "m",
          replyTo: "coordinator",
          sentAt: TEST_NOW,
          baselineTurnId: null,
          suppressed: false,
        },
      });
      const outcome = yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          yield* store.put(inFlightRecord);
          const sent = yield* remote.send(inFlightRecord, {
            text: "Then do this.",
            sender,
            replyTo: "coordinator",
            runtimeMode: "approval-required",
          });
          return { sent, record: Option.getOrThrow(yield* store.get("remote-1")) };
        }),
      );
      expect(outcome.sent).toEqual({ queued: true });
      expect(peer.commands).toEqual([]);
      expect(outcome.record.queuedSends[0]?.sender).toEqual(sender);
      expect(outcome.record.queuedSends.map((entry) => entry.text)).toEqual(["Then do this."]);
    }),
  );

  it.effect(
    "starts the oldest queued send once the peer is idle, and removes only the accepted request",
    () =>
      Effect.gen(function* () {
        const { peer, run } = harness();
        const queuedRecord = makeRecord({
          queuedSends: [
            {
              messageId: "cp-remote-send:remote-1:q1",
              text: "First.",
              sender: { id: "peer", title: "Research" },
              replyTo: "coordinator",
              queuedAt: TEST_NOW,
            },
            {
              messageId: "cp-remote-send:remote-1:q2",
              text: "Second.",
              replyTo: "coordinator",
              queuedAt: TEST_NOW,
            },
          ],
        });
        const view = makePeerThread("remote-1");
        const record = yield* run(
          Effect.gen(function* () {
            const store = yield* RemoteAgentStore;
            const remote = yield* RemoteAgents;
            yield* store.put(queuedRecord);
            yield* remote.startQueued(queuedRecord, view);
            return Option.getOrThrow(yield* store.get("remote-1"));
          }),
        );
        const start = peer.commands[0];
        expect(start?.type === "thread.turn.start" && start.message.source).toMatchObject({
          threadId: "peer",
          threadTitle: "Research",
        });
        expect(start?.type === "thread.turn.start" && start.message.text).toBe("First.");
        expect(record.queuedSends.map((entry) => entry.text)).toEqual(["Second."]);
        expect(record.inFlight?.messageId).toBe("cp-remote-send:remote-1:q1");
      }),
  );

  it.effect(
    "retains the queue and restores the hold when the branch changes after a manual resume",
    () =>
      Effect.gen(function* () {
        const { peer, run } = harness();
        const record = makeRecord({
          resumeCheckpoint: { root: "/work/acme", branch: "feature", commit: "a".repeat(40) },
          queuedSends: [
            { messageId: "queued", text: "Finish.", replyTo: "coordinator", queuedAt: TEST_NOW },
          ],
        });
        yield* run(
          Effect.gen(function* () {
            const store = yield* RemoteAgentStore;
            const agents = yield* RemoteAgents;
            yield* store.put(record);
            const result = yield* Effect.result(
              agents.startQueued(record, makePeerThread(record.threadId)),
            );
            expect(result._tag).toBe("Failure");
            const held = Option.getOrThrow(yield* store.get(record.threadId));
            expect(held.waitId).toBeTruthy();
            expect(held.queuedSends).toEqual(record.queuedSends);
            expect(peer.commands).toEqual([]);
          }),
        );
      }),
  );

  it.effect("does not start a queued send while the peer is busy", () =>
    Effect.gen(function* () {
      const { peer, run } = harness();
      const queuedRecord = makeRecord({
        queuedSends: [
          {
            messageId: "cp-remote-send:remote-1:q1",
            text: "First.",
            replyTo: "coordinator",
            queuedAt: TEST_NOW,
          },
        ],
      });
      const busy = makePeerThread("remote-1", { hasPendingApprovals: true });
      yield* run(
        Effect.gen(function* () {
          const store = yield* RemoteAgentStore;
          const remote = yield* RemoteAgents;
          yield* store.put(queuedRecord);
          yield* remote.startQueued(queuedRecord, busy);
        }),
      );
      expect(peer.commands).toEqual([]);
    }),
  );
});
