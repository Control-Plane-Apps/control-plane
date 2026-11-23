import type { EnvironmentId, TaskSyncStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assistantSignInWarning,
  pickTaskSyncTarget,
  rolloverGapWarning,
  taskAuthorityEnvironment,
  taskSyncStateLabel,
} from "./taskSyncServers.logic";

const MINI = "env-mini" as EnvironmentId;
const MACBOOK = "env-macbook" as EnvironmentId;
const rows = [
  { environmentId: MINI, label: "Mac mini", isPrimary: true },
  { environmentId: MACBOOK, label: "MacBook", isPrimary: false },
];

const authority = (over: Partial<NonNullable<TaskSyncStatus["authority"]>>) => ({
  authority: false,
  synced: false,
  assistantHere: false,
  signInNeeded: false,
  rolls: false,
  rolloverEnabled: true,
  rolloverGap: false,
  machines: [],
  ...over,
});
const status = (
  state: TaskSyncStatus["state"],
  over: Partial<NonNullable<TaskSyncStatus["authority"]>>,
): TaskSyncStatus => ({ state, pendingChanges: 0, weekStartsOn: 1, authority: authority(over) });

// The state Nick hit: the Assistant on an unsynced mini, the MacBook synced.
const miniStatus = status("signed-out", {
  assistantHere: true,
  signInNeeded: true,
  deferTo: { id: MACBOOK, label: "MacBook" },
});
const macbookStatus = status("synced", { authority: true, synced: true, rolls: true });
const statuses: Record<string, TaskSyncStatus> = { [MINI]: miniStatus, [MACBOOK]: macbookStatus };

describe("Task Sync servers", () => {
  it("opens the card on the Assistant's server when it needs a sign-in", () => {
    expect(pickTaskSyncTarget({ rows, statuses, tasksEnvironmentId: MACBOOK })).toBe(MINI);
    expect(
      pickTaskSyncTarget({
        rows,
        statuses: { [MACBOOK]: macbookStatus },
        tasksEnvironmentId: MACBOOK,
      }),
    ).toBe(MACBOOK);
  });

  it("writes the rollover choice to the synced authority", () => {
    expect(taskAuthorityEnvironment({ rows, statuses, tasksEnvironmentId: MINI })).toBe(MACBOOK);
    expect(taskAuthorityEnvironment({ rows, statuses: {}, tasksEnvironmentId: MINI })).toBe(MINI);
  });

  it("says which server needs a sign-in and where the tasks are", () => {
    expect(assistantSignInWarning({ rows, statuses })).toBe(
      "Your Assistant runs on Mac mini, which isn't signed in to Task Sync. Its task tools can't see your tasks (they are on MacBook) until you sign in Mac mini below.",
    );
    expect(assistantSignInWarning({ rows, statuses: { [MACBOOK]: macbookStatus } })).toBeNull();
  });

  it("warns about a rollover gap only when a server reports one", () => {
    expect(rolloverGapWarning(statuses)).toBeNull();
    expect(rolloverGapWarning({ [MINI]: status("synced", { rolloverGap: true }) })).not.toBeNull();
  });

  it("labels each state", () => {
    expect(taskSyncStateLabel(null)).toBe("Checking…");
    expect(taskSyncStateLabel(miniStatus)).toBe("Not signed in");
    expect(taskSyncStateLabel(macbookStatus)).toBe("Signed in and synced");
  });
});
