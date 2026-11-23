import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { TaskSyncCard } from "../components/tasks/TaskSyncCard";
import { TaskSyncServers } from "../components/tasks/TaskSyncServers";
import {
  assistantSignInWarning,
  pickTaskSyncTarget,
  rolloverGapWarning,
  taskAuthorityEnvironment,
  type TaskSyncServerRow,
} from "../components/tasks/taskSyncServers.logic";
import { Switch } from "../components/ui/switch";
import { usePrimarySettings, useUpdateEnvironmentSettings } from "../hooks/useSettings";
import { useServerConfigs } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useTaskEnvironmentId } from "../state/tasks";
import { useTaskSyncStatuses } from "../state/taskSync";

function useTaskSyncServerRows(): ReadonlyArray<TaskSyncServerRow> {
  const { environments } = useEnvironments();
  const configs = useServerConfigs();
  const primaryId = usePrimaryEnvironmentId();
  return useMemo(
    () =>
      environments
        .filter(
          (environment) =>
            configs.get(environment.environmentId)?.environment.capabilities.tasks === true,
        )
        .map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          isPrimary: environment.environmentId === primaryId,
        }))
        .toSorted((a, b) => Number(b.isPrimary) - Number(a.isPrimary)),
    [configs, environments, primaryId],
  );
}

function RolloverRow(props: { readonly target: EnvironmentId; readonly enabled: boolean }) {
  const updateSettings = useUpdateEnvironmentSettings(props.target);
  return (
    <Switch
      checked={props.enabled}
      onCheckedChange={(checked) =>
        updateSettings({ taskRolloverToCurrentPeriod: Boolean(checked) })
      }
      aria-label="Roll unfinished commitments into the current week, month or year"
    />
  );
}

function TaskSyncSettingsPanel() {
  const rows = useTaskSyncServerRows();
  const statuses = useTaskSyncStatuses();
  const tasksEnvironmentId = useTaskEnvironmentId();
  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const suggested = pickTaskSyncTarget({ rows, statuses, tasksEnvironmentId });
  const selected =
    chosen !== null && rows.some((row) => row.environmentId === chosen) ? chosen : suggested;
  const selectedRow = rows.find((row) => row.environmentId === selected);
  const authorityEnvironmentId = taskAuthorityEnvironment({ rows, statuses, tasksEnvironmentId });
  const authorityStatus =
    authorityEnvironmentId === null ? undefined : statuses[authorityEnvironmentId];
  const primaryRollForward = usePrimarySettings((settings) => settings.taskRolloverToCurrentPeriod);
  // The account-wide choice as the authority sees it; this machine's setting before that is known.
  const rollForward = authorityStatus?.authority?.rolloverEnabled ?? primaryRollForward;
  const signInWarning = assistantSignInWarning({ rows, statuses });
  const gapWarning = rolloverGapWarning(statuses);

  return (
    <SettingsPageContainer>
      <SettingsSection id="task-sync" title="Task Sync">
        <div className="flex flex-col gap-3 p-4">
          {signInWarning !== null ? (
            <p className="rounded-md bg-warning/8 px-3 py-2 text-sm text-warning-foreground">
              {signInWarning}
            </p>
          ) : null}
          <TaskSyncServers rows={rows} selected={selected} onSelect={setChosen} />
          <TaskSyncCard
            environmentId={selected}
            {...(selectedRow !== undefined && !selectedRow.isPrimary
              ? { serverLabel: selectedRow.label }
              : {})}
          />
        </div>
      </SettingsSection>
      <SettingsSection id="task-commitments" title="Commitments">
        <SettingsRow
          title="Roll unfinished commitments into the current week, month or year"
          description={
            rows.length > 1
              ? "When a week, month or year ends, its open commitments move to the current one. One setting for all your signed-in servers; only the server that holds your tasks moves them."
              : "When a week, month or year ends, its open commitments move to the current one."
          }
          status={
            gapWarning !== null ? (
              <span className="text-warning-foreground">{gapWarning}</span>
            ) : undefined
          }
          settingKeys={["taskRolloverToCurrentPeriod"]}
          control={
            authorityEnvironmentId === null ? null : (
              <RolloverRow target={authorityEnvironmentId} enabled={rollForward} />
            )
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/task-sync")({
  component: TaskSyncSettingsPanel,
});
