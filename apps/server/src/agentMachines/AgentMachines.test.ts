import {
  HostProcessEnvironment,
  HostProcessHomeDirectory,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import { AGENT_MACHINE_PROTOCOL_VERSION } from "./AgentMachineClient.ts";
import { AgentMachines, AgentMachinesLive, agentMachineSecretName } from "./AgentMachines.ts";
import { RemoteAgentStore } from "./RemoteAgentStore.ts";
import {
  MemoryRemoteAgentStore,
  TEST_NOW,
  makePeerThread,
  makeRecord,
  peerProject,
} from "./testFixtures.ts";

const JsonString = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(JsonString);

const MINI_URL = "http://100.101.102.103:4000";
const HOME_PROJECT_ID = ProjectId.make("home-project");

const homeProject: OrchestrationProjectShell = {
  ...peerProject,
  id: HOME_PROJECT_ID,
  workspaceRoot: "/work/acme",
  assistant: { coordinatorThreadId: "home-coordinator" as never },
};

const descriptorBody = (environmentId = "env-mini", label = "Mac Mini") => ({
  environmentId,
  label,
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.40",
  orchestrationProtocolVersion: AGENT_MACHINE_PROTOCOL_VERSION,
  capabilities: {},
});

interface PeerState {
  descriptor: ReturnType<typeof descriptorBody>;
  projects: ReadonlyArray<OrchestrationProjectShell>;
  threads: ReadonlyArray<ReturnType<typeof makePeerThread>>;
  reachable: boolean;
  workspace: { root: string; branch: string; commit: string };
  idle: boolean;
  tokenStatus: number;
  renewStatus: number;
  renewRefusal: string | null;
  renewed: number;
  /** When set, a renew request waits for it before answering. */
  renewGate: Deferred.Deferred<void> | null;
  /** The issuer renews but the answer is lost (connection reset) this many times. */
  dropRenewAnswers: number;
  renewSeen: Deferred.Deferred<void> | null;
}

/** One linked machine answering the routes the service uses; every request is recorded. */
const makePeer = (overrides: Partial<PeerState> = {}) => {
  const state: PeerState = {
    descriptor: descriptorBody(),
    projects: [peerProject],
    threads: [],
    reachable: true,
    workspace: { root: "/original", branch: "feature", commit: "a".repeat(40) },
    idle: true,
    tokenStatus: 200,
    renewStatus: 200,
    renewRefusal: null,
    renewed: 0,
    renewGate: null,
    dropRenewAnswers: 0,
    renewSeen: null,
    ...overrides,
  };
  const requests: Array<{
    method: string;
    path: string;
    authorization: string | undefined;
    body?: string;
  }> = [];
  const lostAnswer = { pending: (overrides.dropRenewAnswers ?? 0) > 0 };
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers["authorization"],
        ...(request.body._tag === "Uint8Array"
          ? { body: new TextDecoder().decode(request.body.body) }
          : {}),
      });
      const answer = (status: number, body: unknown) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(encodeJson(body), {
              status,
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      if (!state.reachable) return Effect.fail(new Error("connect ECONNREFUSED") as never);
      if (url.pathname === "/.well-known/t3/environment") return answer(200, state.descriptor);
      if (url.pathname === "/oauth/token") {
        return state.tokenStatus === 200
          ? answer(200, {
              access_token: "peer-token",
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              token_type: "Bearer",
              expires_in: 2_592_000,
              scope: "orchestration:read orchestration:operate",
            })
          : answer(state.tokenStatus, {
              _tag: "EnvironmentHttpUnauthorizedError",
              message: "no",
            });
      }
      if (url.pathname === "/api/agent-machine/renew") {
        if (state.renewRefusal !== null) return answer(409, { error: state.renewRefusal });
        if (state.renewStatus !== 200) return answer(state.renewStatus, {});
        const respond = Effect.suspend(() => {
          if (state.dropRenewAnswers > 0) {
            state.dropRenewAnswers -= 1;
            // Renewed on the issuer; the answer never arrives. A retry gets the same token.
            if (state.renewed === 0) state.renewed = 1;
            return Effect.fail(new Error("socket hang up") as never);
          }
          if (state.renewed > 0 && lostAnswer.pending) {
            lostAnswer.pending = false;
            return answer(200, {
              access_token: `renewed-token-${state.renewed}`,
              token_type: "Bearer",
              expires_in: 2_592_000,
            });
          }
          state.renewed += 1;
          return answer(200, {
            access_token: `renewed-token-${state.renewed}`,
            token_type: "Bearer",
            expires_in: 2_592_000,
          });
        });
        const seen = state.renewSeen;
        const gate = state.renewGate;
        return (seen === null ? Effect.void : Deferred.succeed(seen, undefined)).pipe(
          Effect.andThen(gate === null ? Effect.void : Deferred.await(gate)),
          Effect.andThen(respond),
        );
      }
      if (url.pathname === "/api/agent-machine/retire") return answer(200, { revoked: true });
      if (url.pathname === "/api/orchestration/projects/peer-project/agents/remote-1/workspace") {
        return answer(200, { workspace: state.workspace, idle: state.idle });
      }
      if (url.pathname === "/api/orchestration/shell") {
        return answer(200, {
          snapshotSequence: 1,
          projects: state.projects,
          threads: state.threads,
          updatedAt: TEST_NOW,
        });
      }
      return answer(404, {});
    }),
  );
  return { state, requests, layer };
};

interface HarnessInput {
  readonly placement?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly peer?: ReturnType<typeof makePeer>;
  readonly homeThreads?: ReadonlyArray<ReturnType<typeof makePeerThread>>;
}

const harness = (input: HarnessInput = {}) => {
  const peer = input.peer ?? makePeer();
  const layer = AgentMachinesLive.pipe(
    Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
    Layer.provide(Layer.succeed(HostProcessEnvironment, {})),
    Layer.provide(Layer.succeed(HostProcessHomeDirectory, "/synthetic-placement/home")),
    Layer.provide(Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) })),
    Layer.provideMerge(MemoryRemoteAgentStore),
    Layer.provideMerge(peer.layer),
    Layer.provideMerge(ServerSettings.layerTest(input.placement ?? {})),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed("env-home" as never),
        getDescriptor: Effect.succeed(descriptorBody("env-home", "This Mac") as never),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [homeProject],
            threads: [...(input.homeThreads ?? [])],
            updatedAt: TEST_NOW,
          }),
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-machines-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | AgentMachines
      | RemoteAgentStore
      | ServerSettings.ServerSettingsService
      | ServerSecretStore.ServerSecretStore
    >,
  ) => effect.pipe(Effect.provide(layer));
  return { peer, run };
};

const linkedMini = {
  agentPlacement: {
    machines: {
      "env-mini": { label: "Mac Mini", baseUrl: MINI_URL, enabled: true, preference: 50 as const },
    },
  },
};

/** Stores a token for the linked machine, as a link would have. */
const storeToken = (machineId = "env-mini", expiresAt = "2026-10-29T00:00:00.000Z") =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.set(
      agentMachineSecretName(machineId),
      new TextEncoder().encode(encodeJson({ token: "peer-token", expiresAt })),
    );
  });

describe("agentMachineSecretName", () => {
  it("encodes the peer-supplied id so it cannot name another file", () => {
    const name = agentMachineSecretName("../../etc/passwd");
    expect(name).toMatch(/^agent-machine-token-[A-Za-z0-9_-]+$/);
    expect(name).not.toContain("/");
    expect(name).not.toContain(".");
  });
});

describe("AgentMachines.manage link", () => {
  it.effect("exchanges the pairing link, stores the token and adds the machine", () => {
    const h = harness();
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        const settings = yield* ServerSettings.ServerSettingsService;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const result = yield* machines.manage({
          action: "link",
          pairingUrl: `${MINI_URL}/pair#token=ABC123`,
        });
        expect(result.linked).toEqual({ id: "env-mini", label: "Mac Mini" });
        expect(result.machines.map((machine) => [machine.id, machine.status])).toEqual([
          ["env-mini", "connected"],
        ]);
        const saved = (yield* settings.getSettings).agentPlacement.machines["env-mini"];
        expect(saved).toEqual({
          label: "Mac Mini",
          baseUrl: MINI_URL,
          enabled: true,
          preference: 50,
        });
        const stored = yield* secrets.get(agentMachineSecretName("env-mini"));
        expect(Option.isSome(stored)).toBe(true);
        // Renewed at once with the exchanged token, so the issuer tags it with this machine's id.
        expect(new TextDecoder().decode(Option.getOrThrow(stored))).toContain("renewed-token-1");
        expect(
          h.peer.requests.find((request) => request.path === "/api/agent-machine/renew")
            ?.authorization,
        ).toBe("Bearer peer-token");
        // The credential never reaches settings.
        const persisted = encodeJson(yield* settings.getSettings);
        expect(persisted).not.toContain("peer-token");
        expect(persisted).not.toContain("ABC123");
      }),
    );
  });

  it.effect("keeps a re-linked machine's enabled and preference", () => {
    const h = harness({
      placement: {
        agentPlacement: {
          machines: {
            "env-mini": {
              label: "Mini (mine)",
              baseUrl: "http://old.example.ts.net",
              enabled: false,
              preference: 100,
            },
          },
        },
      },
    });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* machines.manage({ action: "link", pairingUrl: `${MINI_URL}/pair#token=ABC` });
        expect((yield* settings.getSettings).agentPlacement.machines["env-mini"]).toEqual({
          label: "Mini (mine)",
          baseUrl: MINI_URL,
          enabled: false,
          preference: 100,
        });
      }),
    );
  });

  it.effect("uses an address override when the link's address is not reachable from here", () => {
    const h = harness();
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* machines.manage({
          action: "link",
          pairingUrl: "http://127.0.0.1:1/pair#token=ABC",
          baseUrl: MINI_URL,
        });
        expect((yield* settings.getSettings).agentPlacement.machines["env-mini"]?.baseUrl).toBe(
          MINI_URL,
        );
      }),
    );
  });

  it.effect("refuses a link to this machine itself", () => {
    const h = harness({ peer: makePeer({ descriptor: descriptorBody("env-home", "This Mac") }) });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        const failure = yield* Effect.flip(
          machines.manage({ action: "link", pairingUrl: `${MINI_URL}/pair#token=ABC` }),
        );
        expect(failure.detail).toContain("points at this machine");
        expect(h.peer.requests.some((r) => r.path === "/oauth/token")).toBe(false);
      }),
    );
  });

  it.effect("refuses plain http to a public address before any request", () => {
    const h = harness();
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        const failure = yield* Effect.flip(
          machines.manage({ action: "link", pairingUrl: "http://example.com/pair#token=ABC" }),
        );
        expect(failure.detail).toContain("Use https");
        expect(h.peer.requests).toEqual([]);
      }),
    );
  });

  it.effect(
    "refuses a link with no token, and a peer that rejects it, leaving nothing behind",
    () => {
      const h = harness({ peer: makePeer({ tokenStatus: 401 }) });
      return h.run(
        Effect.gen(function* () {
          const machines = yield* AgentMachines;
          const settings = yield* ServerSettings.ServerSettingsService;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          const noToken = yield* Effect.flip(
            machines.manage({ action: "link", pairingUrl: `${MINI_URL}/pair` }),
          );
          expect(noToken.detail).toContain("not a valid pairing link");
          const rejected = yield* Effect.flip(
            machines.manage({ action: "link", pairingUrl: `${MINI_URL}/pair#token=ABC` }),
          );
          expect(rejected.detail).toBeTruthy();
          expect((yield* settings.getSettings).agentPlacement.machines).toEqual({});
          expect(Option.isNone(yield* secrets.get(agentMachineSecretName("env-mini")))).toBe(true);
        }),
      );
    },
  );
});

describe("AgentMachines.manage unlink and check", () => {
  it.effect("unlink removes the entry and token and marks that machine's agents lost", () => {
    const h = harness({ placement: linkedMini });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        const settings = yield* ServerSettings.ServerSettingsService;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const store = yield* RemoteAgentStore;
        yield* storeToken();
        yield* store.put(makeRecord({ threadId: "a", machineId: "env-mini" }));
        yield* store.put(makeRecord({ threadId: "b", machineId: "other" }));
        const result = yield* machines.manage({ action: "unlink", id: "env-mini" });
        expect(result.machines).toEqual([]);
        expect((yield* settings.getSettings).agentPlacement.machines).toEqual({});
        expect(Option.isNone(yield* secrets.get(agentMachineSecretName("env-mini")))).toBe(true);
        expect(Option.getOrThrow(yield* store.get("a")).state).toBe("lost");
        expect(Option.getOrThrow(yield* store.get("b")).state).toBe("open");
      }),
    );
  });

  it.effect("check reports a connected machine with its token expiry and matched Projects", () => {
    const h = harness({ placement: linkedMini });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        yield* storeToken("env-mini", "2026-10-29T00:00:00.000Z");
        const { machines: statuses } = yield* machines.manage({ action: "check" });
        expect(statuses).toEqual([
          {
            id: "env-mini",
            status: "connected",
            tokenExpiresAt: "2026-10-29T00:00:00.000Z",
            matchedProjectCount: 1,
            projectCount: 1,
          },
        ]);
      }),
    );
  });

  it.effect(
    "requires a fresh matching branch, commit, root and idle origin to release one sleep hold",
    () => {
      const peer = makePeer();
      const h = harness({ placement: linkedMini, peer });
      return h.run(
        Effect.gen(function* () {
          const machines = yield* AgentMachines;
          const store = yield* RemoteAgentStore;
          yield* storeToken();
          const checkpoint = { ...peer.state.workspace };
          const record = makeRecord({
            machineId: "env-mini",
            workspaceCheckpoint: checkpoint,
            waitId: "first",
          });
          yield* store.put(record);
          const release = machines.manage({
            action: "resume",
            threadId: record.threadId,
            waitId: "first",
          });
          for (const changed of [
            { branch: "main" },
            { commit: "b".repeat(40) },
            { root: "/other" },
          ]) {
            peer.state.workspace = { ...checkpoint, ...changed };
            expect((yield* Effect.result(release))._tag).toBe("Failure");
          }
          peer.state.workspace = checkpoint;
          peer.state.idle = false;
          expect((yield* Effect.result(release))._tag).toBe("Failure");
          peer.state.idle = true;
          const ready = yield* machines.manage({ action: "check" });
          expect(ready.waitingAgents?.[0]).toMatchObject({ branch: "feature", canResume: true });
          yield* release;
          yield* release;
          expect(Option.getOrThrow(yield* store.get(record.threadId))).toMatchObject({
            waitId: null,
            resumeCheckpoint: checkpoint,
          });
          yield* store.put({ ...record, waitId: "second" });
          expect((yield* Effect.result(release))._tag).toBe("Failure");
          expect(Option.getOrThrow(yield* store.get(record.threadId)).waitId).toBe("second");
        }),
      );
    },
  );

  it.effect("check reports an unreachable machine as offline", () => {
    const h = harness({ placement: linkedMini, peer: makePeer({ reachable: false }) });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        yield* storeToken();
        const { machines: statuses } = yield* machines.manage({ action: "check" });
        expect(statuses[0]).toMatchObject({ id: "env-mini", status: "offline" });
      }),
    );
  });

  it.effect("check reports a machine with no stored token as needing a new link", () => {
    const h = harness({ placement: linkedMini });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        const { machines: statuses } = yield* machines.manage({ action: "check" });
        expect(statuses[0]).toMatchObject({ id: "env-mini", status: "needs-relink" });
        expect(h.peer.requests.some((r) => r.path === "/api/orchestration/shell")).toBe(false);
      }),
    );
  });

  it.effect("check reports a different server at the address, and never sends it the token", () => {
    const h = harness({
      placement: linkedMini,
      peer: makePeer({ descriptor: descriptorBody("env-impostor", "Not the Mini") }),
    });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        yield* storeToken();
        const { machines: statuses } = yield* machines.manage({ action: "check" });
        expect(statuses[0]).toMatchObject({ id: "env-mini", status: "wrong-environment" });
        expect(h.peer.requests.filter((r) => r.authorization !== undefined)).toEqual([]);
      }),
    );
  });

  it.effect("check counts Projects with no match on the machine", () => {
    const h = harness({ placement: linkedMini, peer: makePeer({ projects: [] }) });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        yield* storeToken();
        const { machines: statuses } = yield* machines.manage({ action: "check" });
        expect(statuses[0]).toMatchObject({ matchedProjectCount: 0, projectCount: 1 });
      }),
    );
  });
});

describe("AgentMachines.placementInputs", () => {
  const project = { id: HOME_PROJECT_ID, title: "Acme", workspaceRoot: "/work/acme" };

  it.effect("stays local without probing when every agent runs here", () => {
    const h = harness({ placement: linkedMini });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        const inputs = yield* machines.placementInputs(project, { requested: undefined });
        expect(inputs.localOnly).toBe(true);
        expect(inputs.candidates.map((candidate) => candidate.id)).toEqual(["local"]);
        expect(h.peer.requests).toEqual([]);
      }),
    );
  });

  it.effect("balanced mode probes each enabled machine, matching its Project and load", () => {
    const busy = makePeerThread("busy", {
      session: {
        threadId: "busy" as never,
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: TEST_NOW,
      },
    });
    const h = harness({
      placement: {
        agentPlacement: { mode: "balanced", machines: linkedMini.agentPlacement.machines },
      },
      peer: makePeer({ threads: [busy, makePeerThread("idle")] }),
    });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        const store = yield* RemoteAgentStore;
        yield* storeToken();
        // A placement this home made a moment ago that the peer does not show yet.
        yield* store.put(
          makeRecord({ threadId: "just-placed", machineId: "env-mini", createdAt: TEST_NOW }),
        );
        const inputs = yield* machines.placementInputs(project, { requested: undefined });
        const mini = inputs.candidates.find((candidate) => candidate.id === "env-mini");
        expect(mini).toMatchObject({ label: "Mac Mini", ineligibleReason: null, load: 2 });
        expect(inputs.peerProjectIds.get("env-mini")).toBe(peerProject.id);
        expect(inputs.candidates[0]).toMatchObject({ id: "local", ineligibleReason: null });
      }),
    );
  });

  it.effect("marks a machine without the Project ineligible, with the reason", () => {
    const h = harness({
      placement: {
        agentPlacement: { mode: "balanced", machines: linkedMini.agentPlacement.machines },
      },
      peer: makePeer({ projects: [] }),
    });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        yield* storeToken();
        const inputs = yield* machines.placementInputs(project, { requested: undefined });
        expect(inputs.candidates.find((c) => c.id === "env-mini")?.ineligibleReason).toContain(
          "no matching Project for Acme",
        );
        expect(inputs.peerProjectIds.size).toBe(0);
      }),
    );
  });

  it.effect("marks an unreachable machine ineligible instead of failing", () => {
    const h = harness({
      placement: {
        agentPlacement: { mode: "balanced", machines: linkedMini.agentPlacement.machines },
      },
      peer: makePeer({ reachable: false }),
    });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        yield* storeToken();
        const inputs = yield* machines.placementInputs(project, { requested: undefined });
        expect(inputs.candidates.find((c) => c.id === "env-mini")?.ineligibleReason).not.toBeNull();
        expect(inputs.candidates[0]?.ineligibleReason).toBeNull();
      }),
    );
  });

  it.effect("keeps an older linked machine ineligible when readiness cannot be verified", () => {
    const h = harness({
      placement: {
        agentPlacement: {
          ...linkedMini.agentPlacement,
          mode: "priority",
          machineOrder: ["env-mini"],
        },
      },
    });
    return h.run(
      Effect.gen(function* () {
        yield* storeToken();
        const machines = yield* AgentMachines;
        const inputs = yield* machines.placementInputs(
          { ...project, baseModel: makePeerThread("synthetic").modelSelection },
          { requested: undefined },
        );
        expect(
          inputs.candidates.find((entry) => entry.id === "env-mini")?.ineligibleReason,
        ).toContain("verify Project readiness");
        expect(
          h.peer.requests.find((entry) => entry.path.endsWith("/readiness"))?.authorization,
        ).toBe("Bearer peer-token");
      }),
    );
  });

  it.effect("uses the Project order to select which enabled machines to probe", () => {
    const h = harness({
      placement: {
        agentPlacement: {
          mode: "priority",
          machineOrder: ["env-mini", "local"],
          projectMachineOrders: { [HOME_PROJECT_ID]: ["local"] },
          machines: linkedMini.agentPlacement.machines,
        },
      },
    });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        const inputs = yield* machines.placementInputs(project, { requested: undefined });
        expect(inputs.settings.machineOrder).toEqual(["local"]);
        expect(inputs.candidates.map((candidate) => candidate.id)).toEqual(["local"]);
        expect(h.peer.requests).toEqual([]);
      }),
    );
  });

  it.effect("single mode probes only the chosen machine, and skips disabled ones", () => {
    const h = harness({
      placement: {
        agentPlacement: {
          mode: "single",
          singleMachineId: "env-mini",
          machines: {
            ...linkedMini.agentPlacement.machines,
            "env-studio": {
              label: "Studio",
              baseUrl: "http://studio.ts.net",
              enabled: false,
              preference: 50,
            },
          },
        },
      },
    });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        yield* storeToken();
        const inputs = yield* machines.placementInputs(project, { requested: undefined });
        expect(inputs.candidates.map((candidate) => candidate.id)).toEqual(["local", "env-mini"]);
      }),
    );
  });

  it.effect("an explicit machine probes just that machine, by label", () => {
    const h = harness({
      placement: {
        agentPlacement: { mode: "balanced", machines: linkedMini.agentPlacement.machines },
      },
    });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        yield* storeToken();
        const inputs = yield* machines.placementInputs(project, { requested: "mac mini" });
        expect(inputs.candidates.map((candidate) => candidate.id)).toEqual(["local", "env-mini"]);
      }),
    );
  });

  it.effect(
    "a token the peer refuses reads as needing a new link and is not retried at once",
    () => {
      const h = harness({
        placement: {
          agentPlacement: { mode: "balanced", machines: linkedMini.agentPlacement.machines },
        },
      });
      return h.run(
        Effect.gen(function* () {
          const machines = yield* AgentMachines;
          // No stored token: the machine needs a new link.
          const inputs = yield* machines.placementInputs(project, { requested: undefined });
          expect(inputs.candidates.find((c) => c.id === "env-mini")?.ineligibleReason).toContain(
            "linked again",
          );
          expect(yield* machines.isReachable("env-mini")).toBe(false);
        }),
      );
    },
  );
});

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const StoredToken = Schema.fromJsonString(
  Schema.Struct({
    token: Schema.String,
    expiresAt: Schema.String,
    issuedAt: Schema.optionalKey(Schema.String),
    renewedAt: Schema.optionalKey(Schema.String),
    tagged: Schema.optionalKey(Schema.Boolean),
  }),
);
const RENEW_PATH = "/api/agent-machine/renew";
const RETIRE_PATH = "/api/agent-machine/retire";

/** Stores a token as a link from this build would, issued at `issuedAtMs` for `days`. */
const storeIssuedToken = (issuedAtMs: number, days = 30, token = "peer-token", tagged = true) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.set(
      agentMachineSecretName("env-mini"),
      new TextEncoder().encode(
        encodeJson({
          token,
          issuedAt: iso(issuedAtMs),
          expiresAt: iso(issuedAtMs + days * DAY_MS),
          ...(tagged ? { tagged: true } : {}),
        }),
      ),
    );
  });

const readStored = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const bytes = Option.getOrThrow(yield* secrets.get(agentMachineSecretName("env-mini")));
  return yield* Schema.decodeUnknownEffect(StoredToken)(new TextDecoder().decode(bytes));
});

const checkMini = Effect.gen(function* () {
  const machines = yield* AgentMachines;
  const { machines: statuses } = yield* machines.manage({ action: "check" });
  return statuses.find((status) => status.id === "env-mini")!;
});

describe("AgentMachines link renewal", () => {
  it.effect("does nothing before the token is due and sleeps until it is", () => {
    const h = harness({ placement: linkedMini });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        yield* storeIssuedToken(0);
        yield* TestClock.setTime(20 * DAY_MS - 30 * 60 * 1000);
        expect(yield* machines.renewDueTokens).toBe(30 * 60 * 1000);
        expect(h.peer.requests.some((request) => request.path === RENEW_PATH)).toBe(false);
      }),
    );
  });

  it.effect(
    "renews a due token over the link, proves the new one, then retires the old after a grace",
    () => {
      const h = harness({ placement: linkedMini });
      return h.run(
        Effect.gen(function* () {
          const machines = yield* AgentMachines;
          yield* storeIssuedToken(0);
          yield* TestClock.setTime(21 * DAY_MS);
          yield* machines.renewDueTokens;
          const paths = h.peer.requests.map((request) => request.path);
          // Identity before the token goes out, then renew with the old token, then prove the new one.
          expect(paths.indexOf("/.well-known/t3/environment")).toBeLessThan(
            paths.indexOf(RENEW_PATH),
          );
          const renew = h.peer.requests.find((request) => request.path === RENEW_PATH)!;
          expect(renew.authorization).toBe("Bearer peer-token");
          const proof = h.peer.requests.findLast(
            (request) => request.path === "/api/orchestration/shell",
          )!;
          expect(proof.authorization).toBe("Bearer renewed-token-1");
          const stored = yield* readStored;
          expect(stored.token).toBe("renewed-token-1");
          expect(stored.renewedAt).toBe(iso(21 * DAY_MS));
          expect(stored.expiresAt).toBe(iso(51 * DAY_MS));
          // The old token stays valid for calls in flight, then is given back.
          expect(h.peer.requests.some((request) => request.path === RETIRE_PATH)).toBe(false);
          yield* TestClock.adjust("2 minutes");
          yield* Effect.yieldNow;
          const retire = h.peer.requests.find((request) => request.path === RETIRE_PATH);
          expect(retire?.authorization).toBe("Bearer peer-token");
          const status = yield* checkMini;
          expect(status.tokenRenewedAt).toBe(iso(21 * DAY_MS));
          expect(status.tokenRenewal).toBeUndefined();
        }),
      );
    },
  );

  it.effect(
    "renews an untagged token at once (0.0.91 or a general machine link), then when due",
    () => {
      const h = harness({ placement: linkedMini });
      return h.run(
        Effect.gen(function* () {
          const machines = yield* AgentMachines;
          // 0.0.91 stored no issue time and no tag.
          yield* storeToken("env-mini", iso(30 * DAY_MS));
          yield* TestClock.setTime(1 * DAY_MS);
          yield* machines.renewDueTokens;
          expect(h.peer.state.renewed).toBe(1);
          const stored = yield* readStored;
          expect(stored.token).toBe("renewed-token-1");
          expect(stored.tagged).toBe(true);
          // Tagged now: nothing more until 10 days are left.
          yield* TestClock.setTime(2 * DAY_MS);
          yield* machines.renewDueTokens;
          expect(h.peer.state.renewed).toBe(1);
        }),
      );
    },
  );

  it.effect(
    "a token the issuer already tagged answers too early: remembered, renewed when due",
    () => {
      const peer = makePeer({ renewRefusal: "too-early" });
      const h = harness({ placement: linkedMini, peer });
      return h.run(
        Effect.gen(function* () {
          const machines = yield* AgentMachines;
          yield* storeIssuedToken(0, 30, "peer-token", false);
          yield* TestClock.setTime(1 * DAY_MS);
          const wait = yield* machines.renewDueTokens;
          expect((yield* readStored).tagged).toBe(true);
          expect(wait).toBe(60 * 60 * 1000);
          const status = yield* checkMini;
          expect(status.tokenRenewal).toBeUndefined();
          const renewCalls = () => peer.requests.filter((r) => r.path === RENEW_PATH).length;
          expect(renewCalls()).toBe(1);
          yield* TestClock.setTime(5 * DAY_MS);
          yield* machines.renewDueTokens;
          expect(renewCalls()).toBe(1);
        }),
      );
    },
  );

  it.effect("retries a renewal whose answer was lost and gets the same token", () => {
    const peer = makePeer({ dropRenewAnswers: 1 });
    const h = harness({ placement: linkedMini, peer });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        yield* storeIssuedToken(0);
        yield* TestClock.setTime(21 * DAY_MS);
        const renewing = yield* Effect.forkChild(machines.renewDueTokens);
        // Let the retry's spacing elapse on the test clock.
        for (let step = 0; step < 20; step += 1) {
          yield* Effect.yieldNow;
          yield* TestClock.adjust("1 second");
        }
        yield* Fiber.join(renewing);
        const renewCalls = peer.requests.filter((r) => r.path === RENEW_PATH);
        expect(renewCalls.map((r) => r.authorization)).toEqual([
          "Bearer peer-token",
          "Bearer peer-token",
        ]);
        // The retry repeats the same random request id, which is what lets the issuer answer again.
        const ids = renewCalls.map((r) => /"requestId":"([0-9a-f]{32})"/.exec(r.body ?? "")?.[1]);
        expect(ids[0]).toBeDefined();
        expect(ids[1]).toBe(ids[0]);
        expect(peer.state.renewed).toBe(1);
        expect((yield* readStored).token).toBe("renewed-token-1");
        expect((yield* checkMini).tokenRenewal).toBeUndefined();
      }),
    );
  });

  it.effect("stops when the token was already renewed by another copy of it", () => {
    const peer = makePeer({ renewRefusal: "already-renewed" });
    const h = harness({ placement: linkedMini, peer });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        yield* storeIssuedToken(0);
        yield* TestClock.setTime(21 * DAY_MS);
        yield* machines.renewDueTokens;
        expect((yield* machines.healthOf("env-mini")).status).toBe("needs-relink");
        const status = yield* checkMini;
        expect(status.tokenRenewal).toBe("stopped");
        expect(status.tokenRenewalDetail).toContain("another copy");
        yield* TestClock.adjust("1 day");
        yield* machines.renewDueTokens;
        expect(peer.requests.filter((r) => r.path === RENEW_PATH)).toHaveLength(1);
      }),
    );
  });

  it.effect(
    "a link from a general pairing link is not renewable: it says so and does not retry",
    () => {
      const peer = makePeer({ renewRefusal: "not-renewable" });
      const h = harness({ placement: linkedMini, peer });
      return h.run(
        Effect.gen(function* () {
          const machines = yield* AgentMachines;
          yield* storeIssuedToken(0, 30, "peer-token", false);
          yield* TestClock.setTime(1 * DAY_MS);
          yield* machines.renewDueTokens;
          const status = yield* checkMini;
          expect(status.status).toBe("connected");
          expect(status.tokenRenewal).toBe("not-renewable");
          yield* TestClock.adjust("25 days");
          yield* machines.renewDueTokens;
          expect(peer.requests.filter((r) => r.path === RENEW_PATH)).toHaveLength(1);
        }),
      );
    },
  );

  it.effect("unlink during a renewal waits for it, then gives back the new token", () => {
    const peer = makePeer();
    const h = harness({ placement: linkedMini, peer });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        yield* storeIssuedToken(0);
        yield* TestClock.setTime(21 * DAY_MS);
        peer.state.renewGate = yield* Deferred.make<void>();
        peer.state.renewSeen = yield* Deferred.make<void>();
        const renewing = yield* Effect.forkChild(machines.renewDueTokens);
        yield* Deferred.await(peer.state.renewSeen);
        const unlinking = yield* Effect.forkChild(
          machines.manage({ action: "unlink", id: "env-mini" }),
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(peer.state.renewGate, undefined);
        yield* Fiber.join(renewing);
        yield* Fiber.join(unlinking);
        // Unlink won the token: nothing is restored, and the renewed token went back to the peer.
        expect(Option.isNone(yield* secrets.get(agentMachineSecretName("env-mini")))).toBe(true);
        const retired = peer.requests
          .filter((request) => request.path === RETIRE_PATH)
          .map((request) => request.authorization);
        expect(retired).toContain("Bearer renewed-token-1");
      }),
    );
  });

  it.effect("backs off while the machine is offline and renews when it is back", () => {
    const peer = makePeer({ reachable: false });
    const h = harness({ placement: linkedMini, peer });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        yield* storeIssuedToken(0);
        yield* TestClock.setTime(21 * DAY_MS);
        expect(yield* machines.renewDueTokens).toBe(60 * 1000);
        const attempts = () => peer.requests.length;
        const afterFirst = attempts();
        // Inside the backoff: no new attempt.
        yield* TestClock.adjust("30 seconds");
        yield* machines.renewDueTokens;
        expect(attempts()).toBe(afterFirst);
        // Second failure doubles the wait.
        yield* TestClock.adjust("30 seconds");
        expect(yield* machines.renewDueTokens).toBe(2 * 60 * 1000);
        expect((yield* checkMini).tokenRenewal).toBe("retrying");
        peer.state.reachable = true;
        yield* TestClock.adjust("2 minutes");
        yield* machines.renewDueTokens;
        expect((yield* readStored).token).toBe("renewed-token-1");
        expect((yield* checkMini).tokenRenewal).toBeUndefined();
      }),
    );
  });

  it.effect("stops for good when the issuer refuses the token (revoked or unlinked there)", () => {
    const peer = makePeer({ renewStatus: 401 });
    const h = harness({ placement: linkedMini, peer });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        yield* storeIssuedToken(0);
        yield* TestClock.setTime(21 * DAY_MS);
        yield* machines.renewDueTokens;
        const renewCalls = () => peer.requests.filter((r) => r.path === RENEW_PATH).length;
        expect(renewCalls()).toBe(1);
        expect((yield* machines.healthOf("env-mini")).status).toBe("needs-relink");
        yield* TestClock.adjust("2 days");
        yield* machines.renewDueTokens;
        expect(renewCalls()).toBe(1);
        expect((yield* readStored).token).toBe("peer-token");
      }),
    );
  });

  it.effect("keeps the token and says so when the other machine is too old to renew", () => {
    const peer = makePeer({ renewStatus: 404 });
    const h = harness({ placement: linkedMini, peer });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        yield* storeIssuedToken(0);
        yield* TestClock.setTime(21 * DAY_MS);
        yield* machines.renewDueTokens;
        const status = yield* checkMini;
        expect(status.status).toBe("connected");
        expect(status.tokenRenewal).toBe("peer-outdated");
        expect(status.tokenRenewalDetail).toContain("Update it");
        expect((yield* readStored).token).toBe("peer-token");
      }),
    );
  });

  it.effect("never sends the token to a server that is not the linked machine", () => {
    const peer = makePeer({ descriptor: descriptorBody("env-impostor") });
    const h = harness({ placement: linkedMini, peer });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        yield* storeIssuedToken(0);
        yield* TestClock.setTime(21 * DAY_MS);
        yield* machines.renewDueTokens;
        expect(peer.requests.some((r) => r.authorization !== undefined)).toBe(false);
        expect((yield* checkMini).tokenRenewal).toBe("stopped");
      }),
    );
  });

  it.effect("an expired token is not renewed: the machine needs relinking", () => {
    const h = harness({ placement: linkedMini });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        yield* storeIssuedToken(0);
        yield* TestClock.setTime(31 * DAY_MS);
        yield* machines.renewDueTokens;
        expect(h.peer.state.renewed).toBe(0);
        expect((yield* machines.healthOf("env-mini")).status).toBe("needs-relink");
      }),
    );
  });

  it.effect("unlinking gives the token back to the other machine", () => {
    const h = harness({ placement: linkedMini });
    return h.run(
      Effect.gen(function* () {
        const machines = yield* AgentMachines;
        yield* storeIssuedToken(0);
        yield* machines.manage({ action: "unlink", id: "env-mini" });
        const retire = h.peer.requests.find((request) => request.path === RETIRE_PATH);
        expect(retire?.authorization).toBe("Bearer peer-token");
      }),
    );
  });
});
