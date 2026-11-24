import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey } from "../../lib/scopedEntities";

// Fork-owned. Keeps the threads Nick is likely to open warm, so opening one
// shows current messages at once instead of waiting on the catch-up.
//
// Warming mounts the thread's ordinary state atom for a moment: it reads the
// disk cache, catches up from the cached cursor (or loads the snapshot when
// there is no cache), persists the result, and keeps it in the in-memory
// resume cache for back navigation. Nothing here talks to the server itself.

export const PREFETCH_THREAD_LIMIT = 8;
/** Recently opened threads always make the list, ahead of activity. */
const RECENT_VISIT_LIMIT = 4;
export const PREFETCH_CONCURRENCY = 2;
/** Give up on a thread that cannot reach live in this long (offline host). */
export const PREFETCH_TIMEOUT_MS = 20_000;
/** Stay mounted past live so the debounced cache write lands. */
export const PREFETCH_PERSIST_GRACE_MS = 1_000;
/** A foreground within this long of the last full pass skips it. */
export const PREFETCH_FOREGROUND_COOLDOWN_MS = 60_000;

export interface PrefetchTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

function needsAttention(thread: EnvironmentThreadShell): boolean {
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.hasActionableProposedPlan ||
    thread.session?.status === "running"
  );
}

function isSnoozed(thread: EnvironmentThreadShell, nowMs: number): boolean {
  if (thread.snoozedUntil === null || thread.snoozedUntil === undefined) return false;
  return Date.parse(thread.snoozedUntil) > nowMs;
}

/**
 * The threads worth warming, most likely to be opened first: ones waiting on
 * Nick or running, pinned ones, the last few he opened, then the most recently
 * active. Archived, settled and snoozed threads are left cold.
 */
export function selectPrefetchTargets(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly lastVisitedAtByKey: Readonly<Record<string, string>>;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly nowMs: number;
  readonly limit?: number;
}): ReadonlyArray<PrefetchTarget> {
  const limit = input.limit ?? PREFETCH_THREAD_LIMIT;
  const candidates = input.threads.filter(
    (thread) =>
      input.connectedEnvironmentIds.has(thread.environmentId) &&
      thread.archivedAt === null &&
      thread.settledAt === null &&
      !isSnoozed(thread, input.nowMs),
  );
  const visitedAt = (thread: EnvironmentThreadShell) =>
    input.lastVisitedAtByKey[scopedThreadKey(thread.environmentId, thread.id)] ?? "";
  const byRecentActivity = (left: EnvironmentThreadShell, right: EnvironmentThreadShell) =>
    right.updatedAt.localeCompare(left.updatedAt);

  const ordered: EnvironmentThreadShell[] = [
    ...candidates.filter(needsAttention).sort(byRecentActivity),
    ...candidates.filter((thread) => thread.pinnedAt != null).sort(byRecentActivity),
    ...candidates
      .filter((thread) => visitedAt(thread) !== "")
      .sort((left, right) => visitedAt(right).localeCompare(visitedAt(left)))
      .slice(0, RECENT_VISIT_LIMIT),
    ...[...candidates].sort(byRecentActivity),
  ];

  const seen = new Set<string>();
  const targets: PrefetchTarget[] = [];
  for (const thread of ordered) {
    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ environmentId: thread.environmentId, threadId: thread.id });
    if (targets.length >= limit) break;
  }
  return targets;
}

/** Live or deleted means the thread has caught up as far as it can. */
export function isWarm(state: EnvironmentThreadState): boolean {
  return state.status === "live" || state.status === "deleted";
}

export interface ThreadWarmer {
  /** Mounts the thread's state, resolves once it is warm or gives up. */
  readonly warm: (target: PrefetchTarget) => Promise<void>;
}

/**
 * Warms targets a few at a time. One warm at a time per thread: a thread
 * already warming (say from a push while the foreground pass runs) is skipped.
 */
export function createPrefetchQueue(warmer: ThreadWarmer, concurrency = PREFETCH_CONCURRENCY) {
  const inFlight = new Set<string>();
  const queue: PrefetchTarget[] = [];
  let running = 0;

  const pump = () => {
    while (running < concurrency && queue.length > 0) {
      const target = queue.shift()!;
      const key = scopedThreadKey(target.environmentId, target.threadId);
      running += 1;
      void warmer
        .warm(target)
        .catch(() => undefined)
        .finally(() => {
          running -= 1;
          inFlight.delete(key);
          pump();
        });
    }
  };

  return {
    /** Adds targets; `front` puts them ahead of anything already waiting. */
    enqueue(targets: ReadonlyArray<PrefetchTarget>, options?: { readonly front?: boolean }) {
      const fresh = targets.filter((target) => {
        const key = scopedThreadKey(target.environmentId, target.threadId);
        if (inFlight.has(key)) return false;
        inFlight.add(key);
        return true;
      });
      if (options?.front) queue.unshift(...fresh);
      else queue.push(...fresh);
      pump();
    },
    get pending(): number {
      return queue.length + running;
    },
  };
}
