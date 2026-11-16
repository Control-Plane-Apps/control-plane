import type { EnvironmentId } from "@t3tools/contracts";

/** What the Tasks home resolver needs to know about one enabled environment. */
export interface TaskEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly isPrimary: boolean;
  /**
   * `true`/`false` once the environment's server config is known (live or
   * cached); `null` while it has never been loaded, e.g. a remote that is
   * still reconnecting after a restart.
   */
  readonly supportsTasks: boolean | null;
  /** Tasks plus intents in the environment's (possibly cached) shell snapshot. */
  readonly taskRecordCount: number;
}

/**
 * Pick the environment whose server holds this client's Tasks.
 *
 * Tasks are stored per server. A desktop that only runs its own server keeps
 * them there, but a client attached to another machine (a Mac mini showing the
 * MacBook's Projects, a browser on a remote server) must use the remote's list
 * instead of hiding Tasks because its own server is empty or absent.
 *
 * Order:
 *  1. A Tasks-capable server that already has tasks: the primary first, then
 *     the others in catalog order.
 *  2. The server Tasks resolved to last time, if it is still enabled and not
 *     known to lack Tasks. This keeps the row (in a reconnecting state) while
 *     a remote is offline and its config or snapshot has not loaded yet.
 *  3. The primary, when it supports Tasks (a fresh, empty list).
 *  4. Any other Tasks-capable server.
 */
export function resolveTaskEnvironmentId(input: {
  readonly candidates: ReadonlyArray<TaskEnvironmentCandidate>;
  readonly rememberedEnvironmentId: EnvironmentId | null;
}): EnvironmentId | null {
  const capable = input.candidates.filter((candidate) => candidate.supportsTasks === true);
  const withTasks = capable.filter((candidate) => candidate.taskRecordCount > 0);
  const populated = withTasks.find((candidate) => candidate.isPrimary) ?? withTasks.at(0) ?? null;
  if (populated !== null) return populated.environmentId;

  if (input.rememberedEnvironmentId !== null) {
    const remembered = input.candidates.find(
      (candidate) => candidate.environmentId === input.rememberedEnvironmentId,
    );
    if (remembered !== undefined && remembered.supportsTasks !== false) {
      return remembered.environmentId;
    }
  }

  const primary = capable.find((candidate) => candidate.isPrimary);
  if (primary !== undefined) return primary.environmentId;
  return capable.at(0)?.environmentId ?? null;
}

const TASK_ENVIRONMENT_STORAGE_KEY = "cplane:tasks:environment-id";

export function readRememberedTaskEnvironmentId(): EnvironmentId | null {
  try {
    const value = globalThis.localStorage?.getItem(TASK_ENVIRONMENT_STORAGE_KEY);
    return value ? (value as EnvironmentId) : null;
  } catch {
    return null;
  }
}

export function rememberTaskEnvironmentId(environmentId: EnvironmentId): void {
  try {
    globalThis.localStorage?.setItem(TASK_ENVIRONMENT_STORAGE_KEY, environmentId);
  } catch {
    // Storage is best effort; resolution still works without it.
  }
}
