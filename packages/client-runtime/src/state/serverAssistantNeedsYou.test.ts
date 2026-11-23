import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProjectStatusId,
  ThreadId,
  WS_METHODS,
  type AssistantNeedsYouResult,
  type ServerConfig,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { vi } from "vite-plus/test";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const HOME = EnvironmentId.make("assistant-home");
const TARGET = new PrimaryConnectionTarget({
  environmentId: HOME,
  label: "Assistant home",
  httpBaseUrl: "https://home.example.test",
  wsBaseUrl: "wss://home.example.test",
});
const CONFIG = { settings: DEFAULT_SERVER_SETTINGS } as ServerConfig;

const makeHarness = Effect.fn("ServerAssistantNeedsYouTest.makeHarness")(function* (
  beforeRead: (request: number) => Effect.Effect<void> = () => Effect.void,
) {
  let reads = 0;
  const client = {
    [WS_METHODS.subscribeServerConfig]: () => Stream.never,
    [WS_METHODS.serverAssistantNeedsYou]: () =>
      Effect.gen(function* () {
        reads += 1;
        yield* beforeRead(reads);
        return {
          items: [],
          machines: [{ environmentId: HOME, label: String(reads), state: "online" }],
        } satisfies AssistantNeedsYouResult;
      }),
    [WS_METHODS.serverAssistantNeedsYouReply]: () => Effect.succeed({ queued: true }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed(CONFIG),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environments = EnvironmentRegistry.of({
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"]);
  const cache = EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeed(Option.none()),
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry, environments),
      Layer.succeed(EnvironmentCacheStore, cache),
    ),
  );
  const initialConfig = Atom.make(CONFIG);
  const atoms = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: () => initialConfig,
  });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const target = { environmentId: HOME, input: {} };
  const query = atoms.assistantNeedsYou(target);
  const waitForRead = (count: number) =>
    AtomRegistry.toStream(registry, query).pipe(
      Stream.filter(
        (result) =>
          AsyncResult.isSuccess(result) &&
          !result.waiting &&
          result.value.machines[0]?.label === String(count),
      ),
      Stream.runHead,
    );
  return { atoms, registry, target, query, waitForRead, reads: () => reads };
});

it.effect("shares the aggregate query across badge and Overview consumers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const second = harness.atoms.assistantNeedsYou({ environmentId: HOME, input: {} });
      expect(second).toBe(harness.query);
      const unmountBadge = harness.registry.mount(harness.query);
      const unmountOverview = harness.registry.mount(second);
      yield* harness.waitForRead(1);
      expect(harness.reads()).toBe(1);
      unmountBadge();
      unmountOverview();
    }),
  ),
);

it.effect("refreshes the shared aggregate after a queued reply succeeds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const unmount = harness.registry.mount(harness.query);
      yield* harness.waitForRead(1);
      const result = yield* Effect.promise(() =>
        harness.atoms.assistantNeedsYouReply.run(harness.registry, {
          environmentId: HOME,
          input: {
            environmentId: EnvironmentId.make("server-only"),
            projectId: ProjectId.make("project"),
            coordinatorThreadId: ThreadId.make("coordinator"),
            statusId: ProjectStatusId.make("question"),
            openedAt: "2026-11-23T12:00:00.000Z",
            text: "Continue",
          },
        }),
      );
      expect(AsyncResult.isSuccess(result)).toBe(true);
      yield* harness.waitForRead(2);
      expect(harness.reads()).toBe(2);
      unmount();
    }),
  ),
);

it.live("lets an aggregate read finish when it takes longer than the polling interval", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => vi.useFakeTimers()),
        () => Effect.sync(() => vi.useRealTimers()),
      );
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let interrupted = 0;
      const harness = yield* makeHarness((request) =>
        request === 1
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted += 1;
                }),
              ),
            )
          : Effect.void,
      );
      const unmount = harness.registry.mount(harness.query);
      yield* Deferred.await(started);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(45_000));
      expect(harness.reads()).toBe(1);
      expect(interrupted).toBe(0);
      yield* Deferred.succeed(release, undefined);
      yield* harness.waitForRead(1);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(14_999));
      expect(harness.reads()).toBe(1);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
      yield* harness.waitForRead(2);
      expect(harness.reads()).toBe(2);
      unmount();
    }),
  ),
);
