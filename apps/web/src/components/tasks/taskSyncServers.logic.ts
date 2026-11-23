import type { EnvironmentId, TaskSyncStatus } from "@t3tools/contracts";

/** One connected server that keeps Tasks, as Settings > Task Sync lists it. */
export interface TaskSyncServerRow {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
}

/** A short line for a server's Task Sync state. */
export function taskSyncStateLabel(status: TaskSyncStatus | null): string {
  if (status === null) return "Checking…";
  switch (status.state) {
    case "unavailable":
      return "Task Sync not available in this build";
    case "coming-soon":
      return "Task Sync coming soon";
    case "signed-out":
      return "Not signed in";
    case "inactive":
      return "Signed in, subscription not active";
    case "syncing":
      return "Syncing…";
    case "error":
      return "Signed in, last sync failed";
    case "synced":
      return "Signed in and synced";
  }
}

/**
 * The server the Task Sync card opens on: one that runs the Assistant but is
 * not signed in while another server is (it needs a sign-in for the
 * Assistant's task tools to work), else the server that holds Tasks.
 */
export function pickTaskSyncTarget(input: {
  readonly rows: ReadonlyArray<TaskSyncServerRow>;
  readonly statuses: Readonly<Record<string, TaskSyncStatus>>;
  readonly tasksEnvironmentId: EnvironmentId | null;
}): EnvironmentId | null {
  const needing = input.rows.find(
    (row) => input.statuses[row.environmentId]?.authority?.signInNeeded === true,
  );
  if (needing !== undefined) return needing.environmentId;
  return input.tasksEnvironmentId ?? input.rows[0]?.environmentId ?? null;
}

/**
 * The server whose settings hold the rollover choice the user sees: the task
 * authority among connected servers (a synced one first), else the Tasks
 * server. Any server's choice spreads to the others on the same account; the
 * authority is the one that acts on it.
 */
export function taskAuthorityEnvironment(input: {
  readonly rows: ReadonlyArray<TaskSyncServerRow>;
  readonly statuses: Readonly<Record<string, TaskSyncStatus>>;
  readonly tasksEnvironmentId: EnvironmentId | null;
}): EnvironmentId | null {
  const authorities = input.rows.filter(
    (row) => input.statuses[row.environmentId]?.authority?.authority === true,
  );
  const synced = authorities.find(
    (row) => input.statuses[row.environmentId]?.authority?.synced === true,
  );
  return (
    synced?.environmentId ??
    authorities.find((row) => row.environmentId === input.tasksEnvironmentId)?.environmentId ??
    authorities[0]?.environmentId ??
    input.tasksEnvironmentId
  );
}

/** The warning Settings shows when the Assistant's server cannot see the user's tasks. */
export function assistantSignInWarning(input: {
  readonly rows: ReadonlyArray<TaskSyncServerRow>;
  readonly statuses: Readonly<Record<string, TaskSyncStatus>>;
}): string | null {
  const row = input.rows.find(
    (candidate) => input.statuses[candidate.environmentId]?.authority?.signInNeeded === true,
  );
  if (row === undefined) return null;
  const holder = input.statuses[row.environmentId]?.authority?.deferTo?.label;
  return `Your Assistant runs on ${row.label}, which isn't signed in to Task Sync. Its task tools can't see your tasks${holder === undefined ? "" : ` (they are on ${holder})`} until you sign in ${row.label} below.`;
}

/** Whether any connected server reports rollover on with nobody rolling. */
export function rolloverGapWarning(
  statuses: Readonly<Record<string, TaskSyncStatus>>,
): string | null {
  return Object.values(statuses).some((status) => status.authority?.rolloverGap === true)
    ? "Rollover is on, but no server has rolled commitments for a while. Check that the server that holds your tasks is awake and signed in."
    : null;
}
