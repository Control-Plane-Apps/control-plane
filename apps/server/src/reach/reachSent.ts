// @effect-diagnostics nodeBuiltinImport:off - hashes request inputs with node:crypto.
/**
 * Requests this server sent to linked machines in the last few minutes, and
 * requests it already accepted. A callee asks the claimed caller to confirm a
 * write over its own pinned link (`confirm` op). The confirmation names the
 * request id, the op, a hash of the input and the machine it was sent to, so
 * a machine that received a real request cannot replay it to another machine
 * or with another op or input; and each id is accepted once.
 * Fork-owned; see docs/internals/assistant-cross-server-reach.md.
 *
 * @module reachSent
 */
import * as NodeCrypto from "node:crypto";

/** How long a sent request can still be confirmed. Longer than any reach call takes. */
export const REACH_CONFIRM_WINDOW_MS = 5 * 60 * 1000;

export interface SentRequest {
  readonly requestId: string;
  readonly op: string;
  readonly inputHash: string;
  /** The environment id of the machine it was sent to. */
  readonly receiver: string;
}

/** The same hash on both ends: a JSON round trip keeps key order and drops undefined. */
export function reachInputHash(input: unknown): string {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify(input ?? null))
    .digest("hex");
}

const sent = new Map<string, { request: SentRequest; at: number }>();
const accepted = new Map<string, number>();

const prune = (map: Map<string, unknown>, nowMs: number, at: (value: never) => number) => {
  for (const [id, value] of map) {
    if (nowMs - at(value as never) > REACH_CONFIRM_WINDOW_MS) map.delete(id);
  }
};

export function noteSent(request: SentRequest, nowMs: number): void {
  prune(sent, nowMs, (value: { at: number }) => value.at);
  sent.set(request.requestId, { request, at: nowMs });
}

/** Whether this server sent exactly this request, to this receiver, in the window. */
export function wasSent(request: SentRequest, nowMs: number): boolean {
  const entry = sent.get(request.requestId);
  return (
    entry !== undefined &&
    nowMs - entry.at <= REACH_CONFIRM_WINDOW_MS &&
    entry.request.op === request.op &&
    entry.request.inputHash === request.inputHash &&
    entry.request.receiver === request.receiver
  );
}

/** Records that a request id was accepted from a caller; false when it was already used. */
export function acceptOnce(callerId: string, requestId: string, nowMs: number): boolean {
  prune(accepted, nowMs, (at: number) => at);
  const key = `${callerId}\u0000${requestId}`;
  if (accepted.has(key)) return false;
  accepted.set(key, nowMs);
  return true;
}
