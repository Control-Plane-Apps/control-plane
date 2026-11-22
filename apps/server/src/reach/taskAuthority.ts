/**
 * Which server is the task authority: the one that runs automatic task writes
 * (commitment rollover) and that clients use for Tasks. With Task Sync on for
 * one account on two servers, both rolling the same commitment would each
 * retire it and create a new membership, so exactly one server may roll.
 *
 * The rule: the server that hosts the user's Assistant. With no Assistant
 * anywhere, every server stays its own authority (one machine, as before).
 * If two linked servers both host one, the lower environment id wins on
 * both, so they agree. What a linked machine hosts is learned from `describe`
 * and kept in `reach-assistants.json`, so the answer is stable across
 * restarts and while that machine is offline.
 *
 * The decision is held in this module (like the account week start in
 * contracts) so the environment descriptor and the rollover read it without
 * a layer cycle. Fork-owned; see docs/internals/assistant-cross-server-reach.md.
 *
 * @module taskAuthority
 */
import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

export interface TaskAuthorityMachine {
  readonly id: string;
  readonly label: string;
  /** Whether it hosts the user's live Assistant, as last described. */
  readonly hasAssistant: boolean;
}

export type TaskAuthorityDecision =
  | { readonly authority: true }
  | {
      readonly authority: false;
      readonly deferTo: { readonly id: string; readonly label: string };
    };

export function decideTaskAuthority(input: {
  readonly selfId: string;
  readonly localAssistant: boolean;
  readonly linked: ReadonlyArray<TaskAuthorityMachine>;
}): TaskAuthorityDecision {
  const hosts = input.linked
    .filter((machine) => machine.hasAssistant && machine.id !== input.selfId)
    .toSorted((a, b) => a.id.localeCompare(b.id));
  const first = hosts[0];
  if (first === undefined) return { authority: true };
  if (input.localAssistant && input.selfId.localeCompare(first.id) < 0) return { authority: true };
  return { authority: false, deferTo: { id: first.id, label: first.label } };
}

let current: TaskAuthorityDecision = { authority: true };

/** The decision in force on this server. */
export function currentTaskAuthority(): TaskAuthorityDecision {
  return current;
}

export function setTaskAuthority(decision: TaskAuthorityDecision): void {
  current = decision;
}

/**
 * The descriptor clients see: a server that defers still offers Tasks (a
 * client connected only to it keeps its list, which Task Sync shares), but
 * says so, and clients connected to the authority too use the authority's.
 */
export function withTaskAuthority(
  descriptor: ExecutionEnvironmentDescriptor,
): ExecutionEnvironmentDescriptor {
  if (current.authority) return descriptor;
  return { ...descriptor, capabilities: { ...descriptor.capabilities, tasksDeferred: true } };
}
