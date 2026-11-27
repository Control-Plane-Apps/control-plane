import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// Fork-owned. Where a coordinator's new agents run. See
// docs/internals/multi-machine-agents.md. Imports only baseSchemas so
// settings.ts and rpc.ts can import this module without a cycle.

/**
 * `local` starts every agent on this machine (today's behaviour), `single`
 * sends them all to one machine, `balanced` spreads them by load.
 */
export const AgentPlacementMode = Schema.Literals(["local", "single", "balanced", "priority"]);
export type AgentPlacementMode = typeof AgentPlacementMode.Type;
export const DEFAULT_AGENT_PLACEMENT_MODE: AgentPlacementMode = "local";

/** The same vocabulary as the client's Load balancing: Prefer, Normal, Less often, Manual only. */
export const AgentMachinePreference = Schema.Literals([100, 50, 25, 0]);
export type AgentMachinePreference = typeof AgentMachinePreference.Type;
export const DEFAULT_AGENT_MACHINE_PREFERENCE: AgentMachinePreference = 50;

/** The linked machine's environment id, as its own descriptor reports it. */
export const AgentMachineId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type AgentMachineId = typeof AgentMachineId.Type;

/** What the user picks for "this machine" in `singleMachineId`. */
export const LOCAL_AGENT_MACHINE = "local";

/** A linked machine. Its bearer token lives in the server secret store, never here. */
export const AgentMachineConfig = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** https, or http to a loopback, private-range or tailnet host. */
  baseUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  preference: AgentMachinePreference.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_MACHINE_PREFERENCE)),
  ),
});
export type AgentMachineConfig = typeof AgentMachineConfig.Type;

const MachineOrder = Schema.Array(AgentMachineId).check(Schema.isMinLength(1), Schema.isUnique());

export const AgentIntegration = Schema.Literals([
  "gh",
  "sentry",
  "readReplica",
  "eas",
  "vercel",
  "posthog",
  "mcp",
]);
export type AgentIntegration = typeof AgentIntegration.Type;
const RequiredIntegrations = Schema.Array(AgentIntegration).check(Schema.isUnique());

export const AgentPlacementSettings = Schema.Struct({
  projectRequirements: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, RequiredIntegrations),
  ),
  machineOrder: Schema.optionalKey(MachineOrder),
  projectMachineOrders: Schema.optionalKey(Schema.Record(TrimmedNonEmptyString, MachineOrder)),
  mode: AgentPlacementMode.pipe(Schema.withDecodingDefault(Effect.succeed("local" as const))),
  /** For `single`: a machine id, or `local`. Null reads as this machine. */
  singleMachineId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** This machine's weight in `balanced`. */
  localPreference: AgentMachinePreference.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_MACHINE_PREFERENCE)),
  ),
  /** Use this machine when no other is eligible. An explicit machine never falls back. */
  allowLocalFallback: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  machines: Schema.Record(AgentMachineId, AgentMachineConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type AgentPlacementSettings = typeof AgentPlacementSettings.Type;

/** Per-entry `machines`, like `usageLimitSources`: `null` removes an entry. */
export const AgentPlacementSettingsPatch = Schema.Struct({
  projectRequirements: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, Schema.NullOr(RequiredIntegrations)),
  ),
  machineOrder: Schema.optionalKey(MachineOrder),
  projectMachineOrders: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, Schema.NullOr(MachineOrder)),
  ),
  mode: Schema.optionalKey(AgentPlacementMode),
  singleMachineId: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  localPreference: Schema.optionalKey(AgentMachinePreference),
  allowLocalFallback: Schema.optionalKey(Schema.Boolean),
  machines: Schema.optionalKey(Schema.Record(AgentMachineId, Schema.NullOr(AgentMachineConfig))),
});
export type AgentPlacementSettingsPatch = typeof AgentPlacementSettingsPatch.Type;

// ── RPC ────────────────────────────────────────────────────────────

export const CoordinatorMoveInput = Schema.Struct({
  action: Schema.Literal("coordinatorMove"),
  projectId: TrimmedNonEmptyString,
  operation: Schema.Literals(["status", "preflight", "move", "retry", "rollback"]),
  destinationId: Schema.optionalKey(AgentMachineId),
  moveId: Schema.optionalKey(TrimmedNonEmptyString),
  approvalDigest: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CoordinatorMoveInput = typeof CoordinatorMoveInput.Type;

export const CoordinatorMoveStatus = Schema.Struct({
  phase: Schema.String,
  ownerId: Schema.String,
  moveId: Schema.optionalKey(Schema.String),
  destinationId: Schema.optionalKey(Schema.String),
  incoming: Schema.optionalKey(Schema.Boolean),
  approvalDigest: Schema.optionalKey(TrimmedNonEmptyString),
  detail: Schema.String,
  ready: Schema.Boolean,
});
export type CoordinatorMoveStatus = typeof CoordinatorMoveStatus.Type;

export const AgentMachinesInput = Schema.Union([
  CoordinatorMoveInput,
  Schema.Struct({
    action: Schema.Literal("link"),
    /** The pairing link created on the other machine. */
    pairingUrl: TrimmedNonEmptyString,
    /** Overrides the link's address when it is not reachable from this machine. */
    baseUrl: Schema.optionalKey(TrimmedNonEmptyString),
    /** Relinking: refuse a link that leads to any other machine than this one. */
    expectedId: Schema.optionalKey(AgentMachineId),
  }),
  Schema.Struct({ action: Schema.Literal("unlink"), id: AgentMachineId }),
  /**
   * Has a linked machine link this one back, so an Assistant on either can
   * reach the other: this machine mints a pairing credential and the other
   * redeems it at `baseUrl`, this machine's address as the other reaches it.
   */
  Schema.Struct({
    action: Schema.Literal("linkBack"),
    id: AgentMachineId,
    baseUrl: TrimmedNonEmptyString,
  }),
  Schema.Struct({ action: Schema.Literal("check") }),
  Schema.Struct({
    action: Schema.Literal("recoverHandoff"),
    threadId: TrimmedNonEmptyString,
    waitId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("resume"),
    destinationId: Schema.optional(AgentMachineId),
    threadId: TrimmedNonEmptyString,
    waitId: TrimmedNonEmptyString,
  }),
]);
export type AgentMachinesInput = typeof AgentMachinesInput.Type;

export const AgentMachineStatusKind = Schema.Literals([
  "connected",
  "offline",
  "needs-relink",
  "incompatible",
  "wrong-environment",
]);
export type AgentMachineStatusKind = typeof AgentMachineStatusKind.Type;

/**
 * - `retrying`: the last renewal failed (machine offline); it is retried with backoff.
 * - `peer-outdated`: the linked machine runs a build without renewal; the token works until it expires.
 * - `stopped`: the linked machine refused the token (revoked or unlinked there, or renewed
 *   elsewhere), or it expired.
 * - `not-renewable`: linked with a general pairing link, not a machine link; it works until it
 *   expires.
 */
export const AgentMachineTokenRenewal = Schema.Literals([
  "retrying",
  "peer-outdated",
  "stopped",
  "not-renewable",
]);
export type AgentMachineTokenRenewal = typeof AgentMachineTokenRenewal.Type;

export const AgentMachinePairingInput = Schema.Struct({
  /** This machine's address as the machine that will redeem the link reaches it. */
  baseUrl: TrimmedNonEmptyString,
  /** Who the link is for, shown in Settings, Connections. */
  label: TrimmedNonEmptyString,
  /**
   * The environment id of the machine that will redeem it, when known (a
   * relink): its token is tagged for that machine, so unlinking it here
   * revokes it. Without it the link is an untagged machine link.
   */
  holderId: Schema.optionalKey(AgentMachineId.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/))),
});
export type AgentMachinePairingInput = typeof AgentMachinePairingInput.Type;

export const AgentMachinePairingResult = Schema.Struct({ pairingUrl: Schema.String });
export type AgentMachinePairingResult = typeof AgentMachinePairingResult.Type;

export const AgentMachineStatus = Schema.Struct({
  id: AgentMachineId,
  status: AgentMachineStatusKind,
  detail: Schema.optionalKey(Schema.String),
  /** When the stored token stops working unless it is renewed first. */
  tokenExpiresAt: Schema.optionalKey(Schema.String),
  /** When the token was last renewed automatically; absent until the first renewal. */
  tokenRenewedAt: Schema.optionalKey(Schema.String),
  /** How automatic renewal stands; absent when it has nothing to report. */
  tokenRenewal: Schema.optionalKey(AgentMachineTokenRenewal),
  /** Why renewal is retrying, waiting or stopped. */
  tokenRenewalDetail: Schema.optionalKey(Schema.String),
  /** Projects on this machine with a matching Project on the linked one. */
  matchedProjectCount: Schema.Int,
  projectCount: Schema.Int,
});
export type AgentMachineStatus = typeof AgentMachineStatus.Type;

export const AgentWorkspaceCheckpoint = Schema.Struct({
  digest: Schema.optionalKey(TrimmedNonEmptyString),
  root: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
});
export type AgentWorkspaceCheckpoint = typeof AgentWorkspaceCheckpoint.Type;

export const HandoffFingerprint = Schema.Struct({
  ...AgentWorkspaceCheckpoint.fields,
  reusableHandoff: Schema.optionalKey(Schema.Literal(true)),
  heldHandoff: Schema.optionalKey(Schema.Literal(true)),
  digest: TrimmedNonEmptyString,
});
export type HandoffFingerprint = typeof HandoffFingerprint.Type;

export const AgentWorkspaceProbe = Schema.Struct({
  position: Schema.optionalKey(Schema.NullOr(AgentWorkspaceCheckpoint)),
  workspace: Schema.NullOr(AgentWorkspaceCheckpoint),
  idle: Schema.Boolean,
});
export type AgentWorkspaceProbe = typeof AgentWorkspaceProbe.Type;

export const AgentHandoffPhase = Schema.Literals([
  "prepared",
  "fencing",
  "fenced",
  "recovering",
  "committed",
]);
export type AgentHandoffPhase = typeof AgentHandoffPhase.Type;

export const WaitingAgent = Schema.Struct({
  handoffPhase: Schema.optionalKey(AgentHandoffPhase),
  threadId: Schema.String,
  title: Schema.String,
  machineId: Schema.String,
  machineLabel: Schema.String,
  branch: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.String),
  canResume: Schema.Boolean,
  recoveryLabel: Schema.optionalKey(Schema.String),
  activationDestination: Schema.optionalKey(AgentMachineId),
  destinations: Schema.optional(
    Schema.Array(Schema.Struct({ id: AgentMachineId, label: TrimmedNonEmptyString })),
  ),
  detail: Schema.String,
  waitId: Schema.String,
});
export type WaitingAgent = typeof WaitingAgent.Type;

export const AgentMachinesResult = Schema.Struct({
  coordinatorMove: Schema.optionalKey(CoordinatorMoveStatus),
  waitingAgents: Schema.optionalKey(Schema.Array(WaitingAgent)),
  /** The entry `link` added. */
  linked: Schema.optionalKey(Schema.Struct({ id: AgentMachineId, label: Schema.String })),
  machines: Schema.Array(AgentMachineStatus),
});
export type AgentMachinesResult = typeof AgentMachinesResult.Type;

export class AgentMachinesError extends Schema.TaggedError<AgentMachinesError>()(
  "AgentMachinesError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
