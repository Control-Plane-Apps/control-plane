import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Schema from "effect/Schema";

import { AgentMachines } from "../agentMachines/AgentMachines.ts";
import { PeerError } from "../agentMachines/AgentMachineClient.ts";
import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { make as makeReach } from "./Reach.ts";
import { reachInputHash, wasSent } from "./reachSent.ts";
import type { OverviewResult } from "./reachProtocol.ts";

let next: () => Effect.Effect<unknown, PeerError> = () => Effect.succeed({ ok: true, result: 1 });
const bodies: Array<{ requestId: string }> = [];

const TestLayer = Layer.mergeAll(
  Layer.mock(AgentMachines)({
    linked: Effect.succeed([{ id: "env-mini", label: "Mac mini" }]),
    reach: (_id, body) =>
      Effect.suspend(() => {
        bodies.push(body as { requestId: string });
        return next();
      }),
    healthOf: () => Effect.succeed({ status: "offline", detail: null, lastSeenAt: "10:42" }),
  }),
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("env-macbook")),
    getDescriptor: Effect.succeed({
      environmentId: EnvironmentId.make("env-macbook"),
      label: "MacBook",
    } as ExecutionEnvironmentDescriptor),
  }),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-reach-client-" })),
  Layer.provideMerge(NodeServices.layer),
);

const machine = { id: "env-mini", label: "Mac mini" };
const caller = { threadId: "t", threadTitle: "Assistant" };

const failure = (error: PeerError) =>
  Effect.gen(function* () {
    next = () => Effect.fail(error);
    const reach = yield* makeReach;
    return yield* reach.call(machine, "describe", {}, caller, Schema.Number).pipe(Effect.flip);
  }).pipe(Effect.provide(TestLayer));

describe("Reach.call", () => {
  it.effect("says offline only when the machine could not be reached", () =>
    Effect.gen(function* () {
      const error = yield* failure(new PeerError({ kind: "unreachable", detail: "down" }));
      expect(error.kind).toBe("offline");
      expect(error.detail).toContain("Mac mini is offline, last seen 10:42");
    }),
  );

  it.effect("reports what a machine that answered said, never that it is offline", () =>
    Effect.gen(function* () {
      const error = yield* failure(
        new PeerError({
          kind: "rejected",
          detail: "The linked machine refused the request (413: Request too large).",
        }),
      );
      expect(error.kind).toBe("refused");
      expect(error.detail).toBe(
        "Mac mini: The linked machine refused the request (413: Request too large).",
      );
    }),
  );

  it.effect("keeps a timeout apart: the machine may still finish", () =>
    Effect.gen(function* () {
      const error = yield* failure(new PeerError({ kind: "timeout", detail: "slow" }));
      expect(error.kind).toBe("timeout");
      expect(error.detail).toContain("may still finish");
    }),
  );

  it.effect("remembers each request it sends, so the callee can confirm it", () =>
    Effect.gen(function* () {
      next = () => Effect.succeed({ ok: true, result: 1 });
      bodies.length = 0;
      const reach = yield* makeReach;
      yield* reach.call(machine, "describe", {}, caller, Schema.Number);
      const requestId = bodies[0]?.requestId ?? "";
      const exact = {
        requestId,
        op: "describe",
        inputHash: reachInputHash({}),
        receiver: "env-mini",
      };
      expect(wasSent(exact, 0)).toBe(true);
      // Replayed elsewhere, as another op, or with another input: not what this machine sent.
      expect(wasSent({ ...exact, receiver: "env-other" }, 0)).toBe(false);
      expect(wasSent({ ...exact, op: "thread.send" }, 0)).toBe(false);
      expect(wasSent({ ...exact, inputHash: reachInputHash({ x: 1 }) }, 0)).toBe(false);
      expect(wasSent({ ...exact, requestId: "someone-else" }, 0)).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("Reach.overview cache recovery", () => {
  it.effect(
    "replaces stale and persisted peer snapshots, including cleared questions and empty boards",
    () =>
      Effect.gen(function* () {
        const project = (projectId: string, question: string | null) => ({
          projectId,
          title: projectId,
          coordinatorThreadId: `${projectId}-coordinator`,
          coordinatorPhase: "idle",
          needsYou:
            question === null
              ? []
              : [
                  {
                    statusId: question,
                    title: question,
                    question: "Continue?",
                    recommendation: "Continue",
                  },
                ],
          moving: [],
        });
        const old: OverviewResult = {
          snapshotSequence: 10,
          projects: [project("control-plane", "assistant-tasks"), project("hometrace", null)],
          workspaces: [],
        };
        const current: OverviewResult = {
          snapshotSequence: 30,
          projects: [project("control-plane", null), project("hometrace", "inspection-follow-up")],
          workspaces: [],
        };
        next = () => Effect.succeed({ ok: true, result: old });
        const reach = yield* makeReach;
        expect((yield* reach.overview(machine, caller)).result).toEqual(old);
        const timeout = () =>
          Effect.fail(new PeerError({ kind: "timeout", detail: "did not answer in time" }));
        next = timeout;
        expect((yield* reach.overview(machine, caller).pipe(Effect.flip)).lastKnown).toEqual(old);
        next = () => Effect.succeed({ ok: true, result: current });
        expect((yield* reach.overview(machine, caller)).result).toEqual(current);
        next = timeout;
        expect((yield* reach.overview(machine, caller).pipe(Effect.flip)).lastKnown).toEqual(
          current,
        );
        // A new Reach instance reads the last successful peer snapshot from disk, not the old question.
        const restarted = yield* makeReach;
        expect((yield* restarted.overview(machine, caller).pipe(Effect.flip)).lastKnown).toEqual(
          current,
        );
        const empty: OverviewResult = {
          snapshotSequence: 31,
          projects: [project("control-plane", null), project("hometrace", null)],
          workspaces: [],
        };
        next = () => Effect.succeed({ ok: true, result: empty });
        yield* restarted.overview(machine, caller);
        next = timeout;
        const restartedAfterClear = yield* makeReach;
        const cached = yield* restartedAfterClear.overview(machine, caller).pipe(Effect.flip);
        expect(cached.lastKnown).toEqual(empty);
        expect(cached.lastKnown?.projects.flatMap((entry) => entry.needsYou)).toEqual([]);
      }).pipe(Effect.provide(TestLayer)),
  );
});
