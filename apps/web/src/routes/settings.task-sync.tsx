import { createFileRoute } from "@tanstack/react-router";

import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { TaskSyncCard } from "../components/tasks/TaskSyncCard";

function TaskSyncSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection id="task-sync" title="Task Sync">
        <div className="p-4">
          <TaskSyncCard />
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/task-sync")({
  component: TaskSyncSettingsPanel,
});
