import { SettingsRow } from "../settings/components/SettingsRow";
import { useTaskSyncAccount } from "./useMobileTasks";

// Fork-owned. Settings row for Task Sync: the Control Plane account tasks
// sync through, so Tasks work while the Mac sleeps.

export function TaskSyncSettingsRow() {
  const account = useTaskSyncAccount();
  return (
    <SettingsRow
      icon="arrow.clockwise"
      label="Task Sync"
      value={account.signedIn ? (account.email ?? "Signed in") : "Sign in to sync tasks"}
      target="SettingsTaskSync"
    />
  );
}
