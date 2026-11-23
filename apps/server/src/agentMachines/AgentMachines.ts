/**
 * Linked machines: linking, tokens, health, and the inputs placement needs.
 * The bearer token lives in the secret store, never in settings, and is sent
 * only after the peer's descriptor proves it is still the machine that was
 * linked. Fork-owned; see docs/internals/multi-machine-agents.md.
 *
 * @module AgentMachines
 */
import {
  LOCAL_AGENT_MACHINE,
  AgentMachinesError,
  type AgentMachineConfig,
  type AgentPlacementSettings,
  type AgentMachinesInput,
  type AgentMachinesResult,
  type AgentMachineStatus,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  dispatchPeerCommand,
  exchangePairingCredential,
  fetchPeerDescriptor,
  fetchPeerShell,
  fetchPeerThread,
  PeerError,
  postPeerReach,
  renewPeerToken,
  requirePeerIdentity,
  retirePeerToken,
  validatePeerBaseUrl,
  type PeerCommand,
} from "./AgentMachineClient.ts";
import {
  LinkRenewRefusal,
  MAX_RENEWAL_SLEEP_MS,
  renewalDueAtMs,
  retireGraceMs,
  retryDelayMs,
  tokenLifetimeMs,
} from "./linkToken.ts";
import { type PlacementCandidate } from "./placement.ts";
import { matchPeerProject, type ProjectMatch } from "./projectMatch.ts";
import { PLACEMENT_GRACE_MS, machineLoad } from "./remoteAgentState.ts";
import { RemoteAgentStore } from "./RemoteAgentStore.ts";
import { isAgentCountedRunning } from "../mcp/toolkits/agents/agentScope.ts";
import { forkParked } from "../serverActivation.ts";

const SNAPSHOT_TTL_MS = 5_000;
/** A machine that failed a probe is not retried this soon. */
const OFFLINE_TTL_MS = 30_000;
const IDENTITY_TTL_MS = 60_000;

const TokenSecret = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.String,
  /** Absent on tokens stored before renewal (0.0.91): their lifetime is assumed to be 30 days. */
  issuedAt: Schema.optionalKey(Schema.String),
  renewedAt: Schema.optionalKey(Schema.String),
  /**
   * The issuer is known to have tagged this token with this machine's id (it
   * renewed, or the issuer said it was too early to). Until then the token is
   * renewed at once, so a link from a general machine link or from 0.0.91 gets
   * a tag the issuer's unlink can revoke.
   */
  tagged: Schema.optionalKey(Schema.Boolean),
});
type TokenSecret = typeof TokenSecret.Type;
const TokenSecretJson = Schema.fromJsonString(TokenSecret);
const decodeTokenSecret = Schema.decodeUnknownOption(TokenSecretJson);
const encodeTokenSecret = Schema.encodeSync(TokenSecretJson);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Encoded like `usageLimitSourceSecretName`: the id comes from the peer and names a file. */
export const agentMachineSecretName = (machineId: string): string =>
  `agent-machine-token-${Buffer.from(machineId, "utf8").toString("base64url")}`;

export interface HomeProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: { readonly canonicalKey: string } | null | undefined;
}

export interface PlacementInputs {
  readonly settings: AgentPlacementSettings;
  /** The settings put every agent on this machine, so no linked machine was probed. */
  readonly localOnly: boolean;
  readonly candidates: ReadonlyArray<PlacementCandidate>;
  /** The matching Project on each reachable linked machine. */
  readonly peerProjectIds: ReadonlyMap<string, string>;
}

export interface AgentMachinesShape {
  readonly manage: (
    input: AgentMachinesInput,
  ) => Effect.Effect<AgentMachinesResult, AgentMachinesError>;
  /** This machine plus every enabled linked machine, with reachability, Project match and load. */
  readonly placementInputs: (
    project: HomeProject,
    options: { readonly requested: string | undefined },
  ) => Effect.Effect<PlacementInputs, AgentMachinesError>;
  /** Cached for a few seconds unless `fresh`; the bridge polls fresh. */
  readonly shell: (
    machineId: string,
    options?: { readonly fresh?: boolean },
  ) => Effect.Effect<OrchestrationShellSnapshot, PeerError>;
  readonly thread: (
    machineId: string,
    threadId: string,
    turnLimit: number,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, PeerError>;
  readonly dispatch: (machineId: string, command: PeerCommand) => Effect.Effect<void, PeerError>;
  /** Marks a machine as needing a fresh link after the peer refused its token. */
  readonly markNeedsRelink: (machineId: string) => Effect.Effect<void>;
  readonly isReachable: (machineId: string) => Effect.Effect<boolean>;
  /** How this machine is named to a linked one. */
  readonly homeLabel: Effect.Effect<string>;
  /** Every linked machine, enabled for placement or not: all are in the Assistant's reach. */
  readonly linked: Effect.Effect<ReadonlyArray<{ readonly id: string; readonly label: string }>>;
  /** Posts one cross-server reach op; fails fast for a few seconds after a failed call. */
  readonly reach: (
    machineId: string,
    body: unknown,
    options?: { readonly timeout?: Duration.Duration; readonly fresh?: boolean },
  ) => Effect.Effect<unknown, PeerError>;
  /** The last known health of a linked machine, and when it last answered. */
  readonly healthOf: (machineId: string) => Effect.Effect<MachineHealth>;
  /**
   * Renews every link token that is due and not waiting out a backoff.
   * Answers how long until the next one may be due, for the renewal loop.
   */
  readonly renewDueTokens: Effect.Effect<number>;
  /** Completes when a link is made, so the renewal loop looks again before its sleep ends. */
  readonly linksChanged: Effect.Effect<void>;
}

/** Renewal that did not succeed, per machine, until it does or the machine is linked again. */
interface RenewalTrouble {
  readonly state: "retrying" | "peer-outdated" | "stopped" | "not-renewable";
  readonly detail: string;
  readonly failures: number;
  readonly nextAttemptAtMs: number;
  /** The token it applies to: a fresh link starts clean. */
  readonly token: string;
  /** Only schedules the next attempt; nothing to show. */
  readonly quiet?: boolean;
}

export interface MachineHealth {
  readonly status: AgentMachineStatus["status"] | "unknown";
  readonly detail: string | null;
  /** ISO time of the last successful call, or null when none this run. */
  readonly lastSeenAt: string | null;
}

/** Unguessable, since a retry with it gets the renewed token back: 128 random bits, hex. */
function newRenewRequestId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Retries of a renew whose answer did not arrive; all land well inside the issuer's grace. */
const RENEW_ANSWER_RETRIES = 3;

/** Two seconds apart, or a quarter of the grace for a short test lifetime. */
function renewRetrySpacing(stored: { readonly issuedAt?: string; readonly expiresAt: string }) {
  const expiresAtMs = Date.parse(stored.expiresAt);
  const issuedAtRaw = stored.issuedAt === undefined ? Number.NaN : Date.parse(stored.issuedAt);
  const lifetimeMs = tokenLifetimeMs({
    issuedAtMs: Number.isNaN(issuedAtRaw) ? undefined : issuedAtRaw,
    expiresAtMs,
  });
  return Duration.millis(Math.max(50, Math.min(2_000, Math.floor(retireGraceMs(lifetimeMs) / 4))));
}

/** After a failed reach call, further calls to that machine fail at once for this long. */
const REACH_OFFLINE_TTL_MS = 10_000;

export class AgentMachines extends Context.Service<AgentMachines, AgentMachinesShape>()(
  "t3/agentMachines/AgentMachines",
) {}

interface Health {
  status: AgentMachineStatus["status"];
  detail?: string;
  checkedAtMs: number;
  /** The failure was a timeout: the peer may be slow, not gone. */
  timedOut?: boolean;
}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const store = yield* RemoteAgentStore;
  const httpClient = yield* HttpClient.HttpClient;

  const health = new Map<string, Health>();
  const lastSeen = new Map<string, number>();
  const shells = new Map<string, { snapshot: OrchestrationShellSnapshot; atMs: number }>();
  const identities = new Map<string, number>();
  const renewal = new Map<string, RenewalTrouble>();
  const linkChanges = yield* Queue.sliding<void>(1);
  /** Serializes token writes: a renewal in flight can never restore a token unlink removed. */
  const tokenLock = yield* Semaphore.make(1);

  const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const withHttp = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    effect.pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

  const placementSettings = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.agentPlacement),
    Effect.mapError(() => new AgentMachinesError({ detail: "Could not read settings." })),
  );

  const readToken = (machineId: string) =>
    secrets.get(agentMachineSecretName(machineId)).pipe(
      Effect.map((bytes) =>
        Option.flatMap(bytes, (value) => decodeTokenSecret(textDecoder.decode(value))),
      ),
      Effect.mapError(
        () => new PeerError({ kind: "unauthorized", detail: "Could not read the stored token." }),
      ),
    );

  const writeToken = (machineId: string, secret: TokenSecret) =>
    secrets.set(agentMachineSecretName(machineId), textEncoder.encode(encodeTokenSecret(secret)));

  const machineConfig = (machineId: string) =>
    settingsService.getSettings.pipe(
      Effect.map((settings) => settings.agentPlacement.machines[machineId]),
      Effect.mapError(
        () => new PeerError({ kind: "unreachable", detail: "Could not read settings." }),
      ),
      Effect.flatMap((config) =>
        config === undefined
          ? Effect.fail(new PeerError({ kind: "rejected", detail: "That machine is not linked." }))
          : Effect.succeed(config),
      ),
    );

  const record = (machineId: string, next: Omit<Health, "checkedAtMs">) =>
    nowMs.pipe(
      Effect.tap((at) => Effect.sync(() => health.set(machineId, { ...next, checkedAtMs: at }))),
    );

  /** Runs `use` against a linked machine after its identity is confirmed, keeping health current. */
  const withPeer = <A>(
    machineId: string,
    use: (peer: {
      baseUrl: string;
      token: string;
      config: AgentMachineConfig;
    }) => Effect.Effect<A, PeerError, HttpClient.HttpClient>,
  ): Effect.Effect<A, PeerError> =>
    Effect.gen(function* () {
      const config = yield* machineConfig(machineId);
      const stored = yield* readToken(machineId);
      if (Option.isNone(stored)) {
        yield* record(machineId, { status: "needs-relink", detail: "No stored token." });
        return yield* new PeerError({
          kind: "unauthorized",
          detail: "This machine needs to be linked again.",
        });
      }
      const verifiedAt = identities.get(machineId);
      const now = yield* nowMs;
      if (verifiedAt === undefined || now - verifiedAt > IDENTITY_TTL_MS) {
        yield* requirePeerIdentity(config.baseUrl, machineId);
        identities.set(machineId, now);
      }
      const result = yield* use({ baseUrl: config.baseUrl, token: stored.value.token, config });
      yield* record(machineId, { status: "connected" });
      lastSeen.set(machineId, yield* nowMs);
      return result;
    }).pipe(
      withHttp,
      Effect.tapError((error) =>
        record(machineId, {
          status:
            error.kind === "unauthorized"
              ? "needs-relink"
              : error.kind === "incompatible"
                ? "incompatible"
                : error.kind === "wrong-environment"
                  ? "wrong-environment"
                  : "offline",
          detail: error.detail,
          ...(error.kind === "timeout" ? { timedOut: true } : {}),
        }).pipe(Effect.tap(() => Effect.sync(() => identities.delete(machineId)))),
      ),
    );

  const shell: AgentMachinesShape["shell"] = (machineId, options) =>
    Effect.gen(function* () {
      const now = yield* nowMs;
      const cached = shells.get(machineId);
      if (options?.fresh !== true && cached !== undefined && now - cached.atMs < SNAPSHOT_TTL_MS) {
        return cached.snapshot;
      }
      const failed = health.get(machineId);
      if (
        options?.fresh !== true &&
        failed !== undefined &&
        failed.status !== "connected" &&
        now - failed.checkedAtMs < OFFLINE_TTL_MS
      ) {
        return yield* new PeerError({
          kind: failed.status === "needs-relink" ? "unauthorized" : "unreachable",
          detail: failed.detail ?? "The linked machine is unavailable.",
        });
      }
      const snapshot = yield* withPeer(machineId, ({ baseUrl, token }) =>
        fetchPeerShell(baseUrl, token),
      );
      shells.set(machineId, { snapshot, atMs: now });
      return snapshot;
    });

  const localLoad = Effect.gen(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    const now = DateTime.formatIso(yield* DateTime.now);
    return snapshot.threads.filter(
      (thread) => thread.archivedAt === null && isAgentCountedRunning(thread, now),
    ).length;
  }).pipe(Effect.catch(() => Effect.succeed(0)));

  const ineligibleReason = (match: ProjectMatch, projectTitle: string): string | null => {
    switch (match.kind) {
      case "matched":
        return null;
      case "missing":
        return `no Project named ${projectTitle} on that machine`;
      case "ambiguous":
        return `${match.count} Projects match ${projectTitle} on that machine`;
    }
  };

  const placementInputs: AgentMachinesShape["placementInputs"] = (project, options) =>
    Effect.gen(function* () {
      const settings = yield* placementSettings;
      const localCandidate = Effect.gen(function* () {
        const descriptor = yield* environment.getDescriptor;
        return {
          id: LOCAL_AGENT_MACHINE,
          label: descriptor.label,
          ineligibleReason: null,
          load: yield* localLoad,
        } satisfies PlacementCandidate;
      });
      // Every agent stays here unless the caller names a machine: no probes.
      if (settings.mode === "local" && options.requested === undefined) {
        return {
          settings,
          localOnly: true,
          candidates: [yield* localCandidate],
          peerProjectIds: new Map<string, string>(),
        } satisfies PlacementInputs;
      }
      const records = yield* store.list.pipe(
        Effect.mapError(() => new AgentMachinesError({ detail: "Could not read remote agents." })),
      );
      const now = yield* nowMs;
      const wanted = options.requested?.trim().toLowerCase();
      const enabled = Object.entries(settings.machines).filter(
        ([id, config]) =>
          config.enabled &&
          (settings.mode === "balanced" ||
            (options.requested !== undefined
              ? id.toLowerCase() === wanted || config.label.toLowerCase() === wanted
              : id === settings.singleMachineId)),
      );
      const peerProjectIds = new Map<string, string>();
      const remote = yield* Effect.forEach(
        enabled,
        ([id, config]) =>
          shell(id).pipe(
            Effect.map((snapshot): PlacementCandidate => {
              const match = matchPeerProject(project, snapshot.projects);
              if (match.kind === "matched") peerProjectIds.set(id, match.projectId);
              const recent = records.filter(
                (agent) =>
                  agent.machineId === id &&
                  agent.state !== "lost" &&
                  now - DateTime.toEpochMillis(DateTime.makeUnsafe(agent.createdAt)) <
                    PLACEMENT_GRACE_MS,
              );
              return {
                id,
                label: config.label,
                ineligibleReason: ineligibleReason(match, project.title),
                load: machineLoad({ snapshot, recentPlacements: recent }),
              };
            }),
            Effect.catch((error) =>
              Effect.succeed<PlacementCandidate>({
                id,
                label: config.label,
                ineligibleReason:
                  error.kind === "unauthorized" ? "needs to be linked again" : error.detail,
                load: 0,
              }),
            ),
          ),
        { concurrency: "unbounded" },
      );
      return {
        settings,
        localOnly: false,
        candidates: [yield* localCandidate, ...remote],
        peerProjectIds,
      } satisfies PlacementInputs;
    });

  const statusOf = (machineId: string, homeProjects: ReadonlyArray<HomeProject>) =>
    Effect.gen(function* () {
      // A check always probes, so a machine that came back shows as connected.
      health.delete(machineId);
      shells.delete(machineId);
      const outcome = yield* Effect.result(shell(machineId));
      const stored = yield* readToken(machineId).pipe(
        Effect.catch(() => Effect.succeed(Option.none())),
      );
      const tokenExpiresAt = Option.match(stored, {
        onNone: () => undefined,
        onSome: (v) => v.expiresAt,
      });
      const trouble = Option.match(stored, {
        onNone: () => undefined,
        onSome: (v) => {
          const known = renewal.get(machineId);
          return known !== undefined && known.token === v.token && known.quiet !== true
            ? known
            : undefined;
        },
      });
      const token = {
        ...(tokenExpiresAt === undefined ? {} : { tokenExpiresAt }),
        ...(Option.isSome(stored) && stored.value.renewedAt !== undefined
          ? { tokenRenewedAt: stored.value.renewedAt }
          : {}),
        ...(trouble === undefined
          ? {}
          : { tokenRenewal: trouble.state, tokenRenewalDetail: trouble.detail }),
      };
      if (outcome._tag === "Failure") {
        const known = health.get(machineId);
        return {
          id: machineId,
          status: known?.status ?? "offline",
          detail: outcome.failure.detail,
          ...token,
          matchedProjectCount: 0,
          projectCount: homeProjects.length,
        } satisfies AgentMachineStatus;
      }
      const matched = homeProjects.filter(
        (project) => matchPeerProject(project, outcome.success.projects).kind === "matched",
      ).length;
      return {
        id: machineId,
        status: "connected",
        ...token,
        matchedProjectCount: matched,
        projectCount: homeProjects.length,
      } satisfies AgentMachineStatus;
    });

  const check = Effect.gen(function* () {
    const settings = yield* placementSettings;
    const local = yield* snapshots
      .getShellSnapshot()
      .pipe(Effect.mapError(() => new AgentMachinesError({ detail: "Could not read Projects." })));
    const homeProjects = local.projects.filter(
      (project) => project.assistant?.archivedAt == null && project.assistant != null,
    );
    return yield* Effect.forEach(
      Object.keys(settings.machines),
      (id) => statusOf(id, homeProjects),
      { concurrency: "unbounded" },
    );
  });

  const link = (input: Extract<AgentMachinesInput, { action: "link" }>) =>
    Effect.gen(function* () {
      const fail = (detail: string) => new AgentMachinesError({ detail });
      const target = yield* Effect.try({
        try: () => resolveRemotePairingTarget({ pairingUrl: input.pairingUrl }),
        catch: () => fail("That is not a valid pairing link. Create one on the other machine."),
      });
      const asPeerFailure = Effect.mapError((error: PeerError) => fail(error.detail));
      const baseUrl = yield* validatePeerBaseUrl(input.baseUrl ?? target.httpBaseUrl).pipe(
        asPeerFailure,
      );
      const descriptor = yield* withHttp(fetchPeerDescriptor(baseUrl)).pipe(asPeerFailure);
      if (input.expectedId !== undefined && descriptor.environmentId !== input.expectedId) {
        return yield* fail(
          "That pairing link is for a different machine than the one being relinked.",
        );
      }
      const selfId = yield* environment.getEnvironmentId;
      if (descriptor.environmentId === selfId) {
        return yield* fail("That link points at this machine.");
      }
      const exchanged = yield* withHttp(
        exchangePairingCredential({
          baseUrl,
          credential: target.credential,
          clientLabel: `Agent placement from ${(yield* environment.getDescriptor).label}`,
        }),
      ).pipe(asPeerFailure);
      const now = yield* DateTime.now;
      const expiresAt = DateTime.formatIso(
        DateTime.add(now, { seconds: exchanged.expiresInSeconds }),
      );
      const secretName = agentMachineSecretName(descriptor.environmentId);
      yield* writeToken(descriptor.environmentId, {
        token: exchanged.token,
        expiresAt,
        issuedAt: DateTime.formatIso(now),
      }).pipe(
        Effect.mapError(() => fail("Could not store the machine's token.")),
        tokenLock.withPermit,
      );
      const existing = (yield* placementSettings).machines[descriptor.environmentId];
      yield* settingsService
        .updateSettings({
          agentPlacement: {
            machines: {
              [descriptor.environmentId]: {
                label: existing?.label ?? descriptor.label,
                baseUrl,
                enabled: existing?.enabled ?? true,
                preference: existing?.preference ?? 50,
              },
            },
          },
        })
        .pipe(
          Effect.tapError(() => secrets.remove(secretName).pipe(Effect.ignore)),
          Effect.mapError(() => fail("Could not save the machine.")),
        );
      health.delete(descriptor.environmentId);
      shells.delete(descriptor.environmentId);
      identities.delete(descriptor.environmentId);
      renewal.delete(descriptor.environmentId);
      // Renew at once so the issuer tags the token with this machine's id before anything uses
      // it (link back needs a tagged token). A tagged link answers "too early", which is fine.
      yield* renewToken(descriptor.environmentId, {
        token: exchanged.token,
        expiresAt,
        issuedAt: DateTime.formatIso(now),
      }).pipe(Effect.ignore);
      yield* Queue.offer(linkChanges, undefined);
      return { id: descriptor.environmentId, label: descriptor.label };
    });

  /** Gives the token back to the peer, so it stops working there too. Best effort: the peer may be away. */
  const retireAtPeer = (id: string) =>
    Effect.gen(function* () {
      const config = yield* machineConfig(id);
      const stored = yield* readToken(id);
      if (Option.isNone(stored)) return;
      yield* requirePeerIdentity(config.baseUrl, id);
      yield* retirePeerToken(config.baseUrl, stored.value.token);
    }).pipe(withHttp, Effect.ignore);

  const unlink = (id: string) =>
    tokenLock.withPermit(
      Effect.gen(function* () {
        const fail = (detail: string) => new AgentMachinesError({ detail });
        yield* retireAtPeer(id);
        yield* settingsService
          .updateSettings({ agentPlacement: { machines: { [id]: null } } })
          .pipe(Effect.mapError(() => fail("Could not save settings.")));
        yield* secrets.remove(agentMachineSecretName(id)).pipe(Effect.ignore);
        const at = DateTime.formatIso(yield* DateTime.now);
        const records = yield* store.list.pipe(Effect.orElseSucceed(() => []));
        for (const agent of records) {
          if (agent.machineId !== id || agent.state === "lost") continue;
          yield* store
            .update(agent.threadId, (current) => ({ ...current, state: "lost", endedAt: at }))
            .pipe(Effect.ignore);
        }
        health.delete(id);
        shells.delete(id);
        identities.delete(id);
        renewal.delete(id);
      }),
    );

  /**
   * Trades the stored token for a fresh one over the link itself: identity
   * first, then renew, then prove the new token works before storing it. The
   * old token is retired after a short grace, for calls already in flight.
   */
  const renewToken = (machineId: string, stored: TokenSecret) =>
    tokenLock.withPermit(
      Effect.gen(function* () {
        const config = yield* machineConfig(machineId);
        const selfId = yield* environment.getEnvironmentId;
        yield* requirePeerIdentity(config.baseUrl, machineId);
        // One id for this renewal and all its retries.
        const requestId = yield* Effect.sync(newRenewRequestId);
        const fresh = yield* renewPeerToken({
          baseUrl: config.baseUrl,
          token: stored.token,
          environmentId: selfId,
          requestId,
        }).pipe(
          // The answer may be lost after the issuer renewed (timeout, reset). Retrying with the
          // old token inside its grace returns the same new token, so retry before giving up.
          Effect.retry({
            times: RENEW_ANSWER_RETRIES,
            while: (error) => error.kind === "timeout" || error.kind === "unreachable",
            schedule: Schedule.spaced(renewRetrySpacing(stored)),
          }),
          Effect.catchIf(
            (error) => error.code === LinkRenewRefusal.tooEarly,
            (error) =>
              // Already tagged by the issuer: remember it, and renew when due.
              (stored.tagged === true
                ? Effect.void
                : writeToken(machineId, { ...stored, tagged: true }).pipe(Effect.ignore)
              ).pipe(Effect.andThen(Effect.fail(error))),
          ),
        );
        const giveBack = retirePeerToken(config.baseUrl, fresh.token).pipe(Effect.ignore);
        yield* fetchPeerShell(config.baseUrl, fresh.token).pipe(Effect.tapError(() => giveBack));
        // Unlinked or relinked meanwhile: the new token is not wanted.
        const current = yield* readToken(machineId);
        const stillLinked = (yield* Effect.result(machineConfig(machineId)))._tag === "Success";
        if (!stillLinked || Option.isNone(current) || current.value.token !== stored.token) {
          yield* giveBack;
          return;
        }
        const now = yield* DateTime.now;
        const issuedAt = DateTime.formatIso(now);
        yield* writeToken(machineId, {
          token: fresh.token,
          expiresAt: DateTime.formatIso(DateTime.add(now, { seconds: fresh.expiresInSeconds })),
          issuedAt,
          renewedAt: issuedAt,
          tagged: true,
        }).pipe(
          Effect.tapError(() => giveBack),
          Effect.mapError(
            () => new PeerError({ kind: "rejected", detail: "Could not store the renewed token." }),
          ),
        );
        shells.delete(machineId);
        yield* record(machineId, { status: "connected" });
        lastSeen.set(machineId, DateTime.toEpochMillis(now));
        const grace = retireGraceMs(fresh.expiresInSeconds * 1000);
        yield* Effect.forkDetach(
          Effect.sleep(grace).pipe(
            Effect.andThen(retirePeerToken(config.baseUrl, stored.token)),
            withHttp,
            Effect.ignore,
          ),
        );
      }).pipe(withHttp),
    );

  const troubleAfter = (
    error: PeerError,
    previous: RenewalTrouble | undefined,
    stored: TokenSecret,
    timing: { readonly lifetimeMs: number; readonly nowMs: number; readonly expiresAtMs: number },
  ): RenewalTrouble => {
    const failures = (previous?.failures ?? 0) + 1;
    const nextAttemptAtMs = timing.nowMs + retryDelayMs({ failures, ...timing });
    if (error.code === LinkRenewRefusal.alreadyRenewed) {
      return {
        state: "stopped",
        detail:
          "This link's token was already renewed by another copy of it. Link the machine again, and unlink it on the other machine if you did not renew it there.",
        failures,
        nextAttemptAtMs: Number.POSITIVE_INFINITY,
        token: stored.token,
      };
    }
    if (error.code === LinkRenewRefusal.notRenewable) {
      return {
        state: "not-renewable",
        detail:
          "Linked with a general pairing link, so it will not renew. Link it again with a machine link (Agent machines, Create link on that machine).",
        failures,
        nextAttemptAtMs: Number.POSITIVE_INFINITY,
        token: stored.token,
      };
    }
    if (error.code === LinkRenewRefusal.tooEarly) {
      return {
        state: "retrying",
        detail: "",
        failures: 0,
        nextAttemptAtMs,
        token: stored.token,
      };
    }
    switch (error.kind) {
      case "unauthorized":
        return {
          state: "stopped",
          detail: "The linked machine no longer accepts this link. Link it again.",
          failures,
          nextAttemptAtMs: Number.POSITIVE_INFINITY,
          token: stored.token,
        };
      case "wrong-environment":
        return {
          state: "stopped",
          detail: error.detail,
          failures,
          nextAttemptAtMs: Number.POSITIVE_INFINITY,
          token: stored.token,
        };
      case "incompatible":
        return {
          state: "peer-outdated",
          detail: `${error.detail} Until then this link ends when its token expires.`,
          failures,
          nextAttemptAtMs,
          token: stored.token,
        };
      default:
        return {
          state: "retrying",
          detail: `Could not renew: ${error.detail}`,
          failures,
          nextAttemptAtMs,
          token: stored.token,
        };
    }
  };

  const renewDueTokens: AgentMachinesShape["renewDueTokens"] = Effect.gen(function* () {
    const settings = yield* placementSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings === null) return MAX_RENEWAL_SLEEP_MS;
    let nextLookMs = MAX_RENEWAL_SLEEP_MS;
    for (const machineId of Object.keys(settings.machines)) {
      const stored = yield* readToken(machineId).pipe(
        Effect.orElseSucceed(() => Option.none<TokenSecret>()),
      );
      if (Option.isNone(stored)) continue;
      const expiresAtMs = Date.parse(stored.value.expiresAt);
      if (Number.isNaN(expiresAtMs)) continue;
      const issuedAtRaw =
        stored.value.issuedAt === undefined ? Number.NaN : Date.parse(stored.value.issuedAt);
      const issuedAtMs = Number.isNaN(issuedAtRaw) ? undefined : issuedAtRaw;
      const lifetimeMs = tokenLifetimeMs({ issuedAtMs, expiresAtMs });
      const dueAtMs = renewalDueAtMs({ issuedAtMs, expiresAtMs });
      const known = renewal.get(machineId);
      const previous =
        known !== undefined && known.token === stored.value.token ? known : undefined;
      const now = yield* nowMs;
      if (now >= expiresAtMs) {
        renewal.set(machineId, {
          state: "stopped",
          detail: "The link expired while this machine could not renew it. Link it again.",
          failures: previous?.failures ?? 0,
          nextAttemptAtMs: Number.POSITIVE_INFINITY,
          token: stored.value.token,
        });
        yield* record(machineId, {
          status: "needs-relink",
          detail: "The link expired. Link it again.",
        });
        continue;
      }
      // Untagged: renew now so the issuer tags it; a "too early" answer means it already is.
      const effectiveDueAtMs = stored.value.tagged === true ? dueAtMs : 0;
      const attemptAtMs = Math.max(effectiveDueAtMs, previous?.nextAttemptAtMs ?? 0);
      if (now < attemptAtMs) {
        nextLookMs = Math.min(nextLookMs, attemptAtMs - now);
        continue;
      }
      const outcome = yield* Effect.result(renewToken(machineId, stored.value));
      if (outcome._tag === "Success") {
        renewal.delete(machineId);
        continue;
      }
      const trouble = troubleAfter(outcome.failure, previous, stored.value, {
        lifetimeMs,
        nowMs: now,
        expiresAtMs,
      });
      if (outcome.failure.code === LinkRenewRefusal.tooEarly) {
        // Not trouble: wait for the due time (or a short retry if the clocks disagree).
        renewal.set(machineId, {
          ...trouble,
          quiet: true,
          nextAttemptAtMs: Math.max(dueAtMs, trouble.nextAttemptAtMs),
        });
        nextLookMs = Math.min(
          nextLookMs,
          Math.max(0, Math.max(dueAtMs, trouble.nextAttemptAtMs) - now),
        );
        continue;
      }
      renewal.set(machineId, trouble);
      if (trouble.state === "stopped") {
        yield* record(machineId, { status: "needs-relink", detail: trouble.detail });
      } else {
        nextLookMs = Math.min(nextLookMs, Math.max(0, trouble.nextAttemptAtMs - now));
      }
      yield* Effect.logWarning("Could not renew a linked machine's token.").pipe(
        Effect.annotateLogs({ machineId, reason: outcome.failure.detail, state: trouble.state }),
      );
    }
    return Math.max(250, nextLookMs);
  });

  const manage: AgentMachinesShape["manage"] = (input) =>
    Effect.gen(function* () {
      switch (input.action) {
        case "link": {
          const linked = yield* link(input);
          return { linked, machines: yield* check };
        }
        case "linkBack":
          // Needs this server's own pairing and the reach route; ws.ts sends it to AssistantHome.
          return yield* new AgentMachinesError({ detail: "Link back is not available here." });
        case "unlink": {
          yield* unlink(input.id);
          return { machines: yield* check };
        }
        case "check":
          return { machines: yield* check };
      }
    });

  return {
    manage,
    placementInputs,
    shell,
    thread: (machineId, threadId, turnLimit) =>
      withPeer(machineId, ({ baseUrl, token }) =>
        fetchPeerThread(baseUrl, token, threadId, turnLimit),
      ),
    dispatch: (machineId, command) =>
      withPeer(machineId, ({ baseUrl, token }) => dispatchPeerCommand(baseUrl, token, command)),
    markNeedsRelink: (machineId) =>
      record(machineId, {
        status: "needs-relink",
        detail: "The linked machine refused the token.",
      }).pipe(Effect.asVoid),
    homeLabel: environment.getDescriptor.pipe(Effect.map((descriptor) => descriptor.label)),
    linked: settingsService.getSettings.pipe(
      Effect.map((settings) =>
        Object.entries(settings.agentPlacement.machines).map(([id, config]) => ({
          id,
          label: config.label,
        })),
      ),
      Effect.orElseSucceed(() => []),
    ),
    reach: (machineId, body, options) =>
      Effect.gen(function* () {
        const failed = health.get(machineId);
        const now = yield* nowMs;
        // After a timeout the next call still goes out: a move's abort or commit must not be held back.
        if (
          failed !== undefined &&
          failed.status !== "connected" &&
          failed.timedOut !== true &&
          options?.fresh !== true &&
          now - failed.checkedAtMs < REACH_OFFLINE_TTL_MS
        ) {
          return yield* new PeerError({
            kind: failed.status === "needs-relink" ? "unauthorized" : "unreachable",
            detail: failed.detail ?? "The linked machine is unavailable.",
          });
        }
        return yield* withPeer(machineId, ({ baseUrl, token }) =>
          postPeerReach(baseUrl, token, body, options?.timeout),
        );
      }),
    healthOf: (machineId) =>
      Effect.sync(() => {
        const known = health.get(machineId);
        const seen = lastSeen.get(machineId);
        return {
          status: known?.status ?? "unknown",
          detail: known?.detail ?? null,
          lastSeenAt: seen === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(seen)),
        } satisfies MachineHealth;
      }),
    renewDueTokens,
    linksChanged: Queue.take(linkChanges).pipe(Effect.asVoid),
    isReachable: (machineId) =>
      Effect.sync(() => health.get(machineId)?.status).pipe(
        Effect.map((status) => status === undefined || status === "connected"),
      ),
  } satisfies AgentMachinesShape;
});

export const AgentMachinesLive = Layer.effect(AgentMachines, make);

/** Keeps every link renewed while this server runs; see `renewDueTokens`. */
export const AgentMachineLinkRenewalLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const machines = yield* AgentMachines;
    yield* forkParked(
      Effect.gen(function* () {
        while (true) {
          const waitMs = yield* machines.renewDueTokens;
          yield* Effect.raceFirst(Effect.sleep(Duration.millis(waitMs)), machines.linksChanged);
        }
      }),
    );
  }),
);
