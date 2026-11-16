import { createFileRoute } from "@tanstack/react-router";

import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { TaskSyncCard } from "../components/tasks/TaskSyncCard";
import { Switch } from "../components/ui/switch";
import { usePrimarySettings, useUpdatePrimarySettings } from "../hooks/useSettings";

function TaskSyncSettingsPanel() {
  const rollForward = usePrimarySettings((settings) => settings.taskRolloverToCurrentPeriod);
  const updateSettings = useUpdatePrimarySettings();
  return (
    <SettingsPageContainer>
      <SettingsSection id="task-sync" title="Task Sync">
        <div className="p-4">
          <TaskSyncCard />
        </div>
      </SettingsSection>
      <SettingsSection id="task-commitments" title="Commitments">
        <SettingsRow
          title="Roll unfinished commitments into the current week, month or year"
          description="When a week, month or year ends, its open commitments move to the current one."
          serverScoped
          settingKeys={["taskRolloverToCurrentPeriod"]}
          control={
            <Switch
              checked={rollForward}
              onCheckedChange={(checked) =>
                updateSettings({ taskRolloverToCurrentPeriod: Boolean(checked) })
              }
              aria-label="Roll unfinished commitments into the current week, month or year"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/task-sync")({
  component: TaskSyncSettingsPanel,
});
