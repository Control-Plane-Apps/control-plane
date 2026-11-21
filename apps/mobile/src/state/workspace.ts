import { useAtomValue } from "@effect/atom-react";
import { useProjects, useServerConfigs } from "./entities";
import { useMemo } from "react";

import { environmentShellSummaryAtom } from "./shell";
import {
  projectWorkspaceEnvironment,
  projectWorkspaceState,
  workspaceStatusEnvironmentIds,
} from "./workspaceModel";
import { useEnvironments } from "./environments";

export function useWorkspaceState(relevantOnly = false) {
  const { isReady, networkStatus, environments } = useEnvironments();
  const shellSummary = useAtomValue(environmentShellSummaryAtom);
  const configs = useServerConfigs();
  const projects = useProjects();
  const relevantIds = useMemo(() => {
    const taskHost = [...configs].find(
      ([, config]) => config.environment.capabilities.tasks === true,
    )?.[0];
    return workspaceStatusEnvironmentIds(
      projects.map((project) => project.environmentId),
      taskHost ?? null,
    );
  }, [configs, projects]);
  const projectedEnvironments = useMemo(
    () =>
      environments
        .filter((environment) => !relevantOnly || relevantIds.has(environment.environmentId))
        .map(projectWorkspaceEnvironment),
    [environments, relevantIds, relevantOnly],
  );
  const state = useMemo(
    () =>
      projectWorkspaceState({
        isReady,
        networkStatus,
        environments: projectedEnvironments,
        shellSummary:
          relevantOnly && projectedEnvironments.length === 0
            ? { ...shellSummary, hasSnapshot: false, hasSynchronizingShell: false }
            : shellSummary,
      }),
    [isReady, networkStatus, projectedEnvironments, shellSummary, relevantOnly],
  );

  return {
    environments: projectedEnvironments,
    state,
  };
}
