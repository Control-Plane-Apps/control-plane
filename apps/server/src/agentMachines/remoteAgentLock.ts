import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const locks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

/** Serialize delivery, stop and bridge completion for one agent, including peer acknowledgements. */
export function withRemoteAgentLock<A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const lock = locks.get(threadId) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
      locks.set(threadId, lock);
      lock.users++;
      return lock;
    }),
    (lock) => lock.semaphore.withPermits(1)(effect),
    (lock) =>
      Effect.sync(() => {
        if (--lock.users === 0) locks.delete(threadId);
      }),
  );
}
