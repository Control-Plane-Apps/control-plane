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
