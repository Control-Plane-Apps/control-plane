import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Fork-owned. Cross-server reach: the user's Assistant on one server reaching
// Projects on a linked server, and coordinators reaching an Assistant on a
// linked server. See docs/internals/assistant-cross-server-reach.md. Imports
// only effect and base schemas so orchestration.ts can import it.

/** The thread on another server that made a server-only write here. */
export const ReachRemoteActor = Schema.Struct({
  /** The linked server's environment id. */
  environmentId: TrimmedNonEmptyString,
  /** That server's label, such as "Mac mini". */
  label: Schema.String,
  /** The thread there; it is not a thread on this server. */
  threadId: ThreadId,
});
export type ReachRemoteActor = typeof ReachRemoteActor.Type;

/** A linked server a task was handed to; the handoff's thread lives there. */
export const ReachMachineRef = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: Schema.String,
});
export type ReachMachineRef = typeof ReachMachineRef.Type;

/** Marks a request from another server in its send id: `cp-send:<target>:...:reach:<uuid>`. */
const REACH_SEGMENT = ":reach:";

/** The uuid slot that marks a send as coming from another server. */
export function reachSendSlot(uuid: string): string {
  return `reach:${uuid}`;
}

/**
 * A request whose `replyTo` is a thread on another server. Its result is not
 * appended here: the reactor records it for the asking server to collect.
 */
export function isReachRequestId(messageId: string): boolean {
  return messageId.startsWith("cp-send:") && messageId.includes(REACH_SEGMENT);
}

/** Kind of the activity that holds a result owed to another server. */
export const REACH_RESULT_ACTIVITY_KIND = "agent-results.remote";

/** Payload of that activity: the formatted result, for the asking server to collect. */
export const ReachResultActivityPayload = Schema.Struct({
  detail: Schema.String,
  replyTo: Schema.String,
  text: Schema.String,
});
export type ReachResultActivityPayload = typeof ReachResultActivityPayload.Type;

// ── Where the Assistant runs (RPC `server.assistantHome`) ─────────

export const AssistantHomeInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("status") }),
  /** Moves the Assistant to a linked machine id, or `"local"` for this machine. */
  Schema.Struct({ action: Schema.Literal("move"), to: TrimmedNonEmptyString }),
]);
export type AssistantHomeInput = typeof AssistantHomeInput.Type;

export const AssistantHomeMachineState = Schema.Literals([
  "online",
  "offline",
  "needs-relink",
  "incompatible",
]);
export type AssistantHomeMachineState = typeof AssistantHomeMachineState.Type;

export const AssistantHomeMachine = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  state: AssistantHomeMachineState,
  detail: Schema.optional(Schema.String),
  lastSeenAt: Schema.optional(Schema.String),
  /** It runs the user's Assistant; null when it has not answered yet. */
  hostsAssistant: Schema.NullOr(Schema.Boolean),
  /** It has linked this machine back, so an Assistant there can reach Projects here. */
  linksBack: Schema.NullOr(Schema.Boolean),
  /** Its Projects as last seen, for the Assistant's reach picker. */
  projects: Schema.Array(Schema.Struct({ projectId: Schema.String, title: Schema.String })),
});
export type AssistantHomeMachine = typeof AssistantHomeMachine.Type;

export const AssistantHomeStatus = Schema.Struct({
  /** This machine runs the live Assistant. */
  here: Schema.Boolean,
  /** The linked machine that runs it, when not this one. */
  elsewhere: Schema.NullOr(Schema.Struct({ id: Schema.String, label: Schema.String })),
  /** Linked machines that also run one: a conflict to resolve by moving one in. */
  conflicts: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  machines: Schema.Array(AssistantHomeMachine),
  /** Addresses linked machines can likely use to reach this one, best first. */
  addresses: Schema.Array(Schema.String),
});
export type AssistantHomeStatus = typeof AssistantHomeStatus.Type;

export class AssistantHomeError extends Schema.TaggedError<AssistantHomeError>()(
  "AssistantHomeError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
