import { Alert } from "react-native";

import { SettingsRow } from "../settings/components/SettingsRow";
import { useTaskSyncAccount } from "./useMobileTasks";

// Fork-owned. Settings, Task Sync: the Control Plane account tasks sync
// through. Sign-in state only; no purchase on iOS.

export function TaskSyncSettingsRow() {
  const account = useTaskSyncAccount();
  return (
    <SettingsRow
      icon="arrow.clockwise"
      label="Task Sync"
      value={account.signedIn ? (account.email ?? "Signed in") : "Sign in to sync tasks"}
      onPress={() =>
        Alert.alert(
          "Control Plane account",
          account.signedIn
            ? `Tasks sync through ${account.email ?? "your Control Plane account"}.`
            : "Sign in to sync tasks. Until then, tasks come from your paired Mac.",
        )
      }
    />
  );
}
