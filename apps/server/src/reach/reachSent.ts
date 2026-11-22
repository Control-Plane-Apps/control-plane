/**
 * Requests this server sent to linked machines in the last few minutes. A
 * callee asks the claimed caller to confirm a write over its own pinned link
 * (`confirm` op), so the caller's identity rests on that link, not on what
 * the request body says. Fork-owned; see
 * docs/internals/assistant-cross-server-reach.md.
 *
 * @module reachSent
 */

/** How long a sent request can still be confirmed. Longer than any reach call takes. */
export const REACH_CONFIRM_WINDOW_MS = 5 * 60 * 1000;

const sent = new Map<string, number>();

export function noteSent(requestId: string, nowMs: number): void {
  for (const [id, at] of sent) {
    if (nowMs - at > REACH_CONFIRM_WINDOW_MS) sent.delete(id);
  }
  sent.set(requestId, nowMs);
}

export function wasSent(requestId: string, nowMs: number): boolean {
  const at = sent.get(requestId);
  return at !== undefined && nowMs - at <= REACH_CONFIRM_WINDOW_MS;
}
