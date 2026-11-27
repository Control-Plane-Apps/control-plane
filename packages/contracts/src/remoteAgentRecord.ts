import * as Schema from "effect/Schema";
import { AgentHandoffPhase, AgentWorkspaceCheckpoint } from "./agentPlacement.ts";
import { RuntimeMode } from "./orchestration.ts";

export const AgentPhase = Schema.Literals([
  "idle",
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
  "stale",
]);
export type AgentPhase = typeof AgentPhase.Type;

export const RemoteAgentRequest = Schema.Struct({
  /** `cp-remote:*`, the message id the peer stores. */
  messageId: Schema.String,
  /** The home thread the result goes to (the manager that asked). */
  replyTo: Schema.String,
  noResult: Schema.optionalKey(Schema.Literal(true)),
  sentAt: Schema.String,
  /** The peer thread's latest turn before the send, so its own turn can be told apart. */
  baselineTurnId: Schema.NullOr(Schema.String),
  /** A stop cut the request off: its result is not pushed. */
  suppressed: Schema.Boolean,
});
export type RemoteAgentRequest = typeof RemoteAgentRequest.Type;

export const RemoteAgentQueuedSend = Schema.Struct({
  messageId: Schema.String,
  text: Schema.String,
  replyTo: Schema.String,
  noResult: Schema.optionalKey(Schema.Literal(true)),
  queuedAt: Schema.String,
  baselineTurnId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sender: Schema.optionalKey(Schema.Struct({ id: Schema.String, title: Schema.String })),
});
export type RemoteAgentQueuedSend = typeof RemoteAgentQueuedSend.Type;

export const RemoteAgentRecord = Schema.Struct({
  /** The peer thread's id, derived from the create like a local agent's. */
  threadId: Schema.String,
  machineId: Schema.String,
  machineLabel: Schema.String,
  /** The worker keeps its initial callback route. A former home forwards to the current owner. */
  placementOrigin: Schema.optionalKey(
    Schema.Struct({ machineId: Schema.String, projectId: Schema.String }),
  ),
  peerProjectId: Schema.String,
  homeProjectId: Schema.String,
  title: Schema.String,
  /** The home thread that started it; ownership follows this. */
  creatorThreadId: Schema.String,
  runtimeMode: RuntimeMode,
  createdAt: Schema.String,
  /** `pending` until the peer accepted the create; `lost` when the peer thread is gone. */
  state: Schema.Literals(["pending", "open", "settled", "lost"]),
  /** When it reached `settled` or `lost`, for pruning. */
  endedAt: Schema.NullOr(Schema.String),
  inFlight: Schema.NullOr(RemoteAgentRequest),
  queuedSends: Schema.Array(RemoteAgentQueuedSend),
  lastPhase: AgentPhase,
  lastActivityAt: Schema.NullOr(Schema.String),
  workspacePosition: Schema.optionalKey(Schema.NullOr(AgentWorkspaceCheckpoint)),
  workspaceCheckpoint: Schema.optionalKey(Schema.NullOr(AgentWorkspaceCheckpoint)),
  createAttempted: Schema.optionalKey(Schema.Boolean),
  firstMessageAccepted: Schema.optionalKey(Schema.Boolean),
  peerReceipts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        messageId: Schema.String,
        senderThreadId: Schema.String,
        text: Schema.String,
        refusal: Schema.optionalKey(Schema.String),
        refusalWindowClosed: Schema.optionalKey(Schema.Literal(true)),
      }),
    ),
  ),
  stoppingAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  workspaceObservedFor: Schema.optionalKey(Schema.String),
  handoffContext: Schema.optionalKey(Schema.NullOr(Schema.String)),
  handoffHomeMachine: Schema.optionalKey(Schema.String),
  handoff: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        waitId: Schema.String,
        phase: Schema.optionalKey(AgentHandoffPhase),
        sourceKey: Schema.optionalKey(Schema.String),
        destinationKey: Schema.optionalKey(Schema.String),
        replacementKey: Schema.optionalKey(Schema.String),
        destinationId: Schema.String,
        projectId: Schema.String,
        sourceRoot: Schema.String,
        targetRoot: Schema.String,
        branch: Schema.String,
        commit: Schema.String,
        digest: Schema.String,
        createdAt: Schema.String,
      }),
    ),
  ),
  notifiedCoordinatorId: Schema.optionalKey(Schema.String),
  notifiedWaitId: Schema.optionalKey(Schema.String),
  waitId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  resumeCheckpoint: Schema.optionalKey(Schema.NullOr(AgentWorkspaceCheckpoint)),
  abandonedHolds: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        destinationId: Schema.String,
        projectId: Schema.String,
        waitId: Schema.String,
        key: Schema.String,
      }),
    ),
  ),
  lastRecoveredWaitId: Schema.optionalKey(Schema.String),
  lastResumedWaitId: Schema.optionalKey(Schema.String),
});
export type RemoteAgentRecord = typeof RemoteAgentRecord.Type;
