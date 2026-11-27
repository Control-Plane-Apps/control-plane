import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useCallback } from "react";
import { useEnvironment } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { agentMachinesErrorMessage, linkedAgentMachines } from "./AgentMachinesSettings.logic";
import {
  CoordinatorPlacementPicker,
  type CoordinatorMoveRequest,
} from "./CoordinatorPlacementPicker";
import { SettingsRow } from "./settingsLayout";

export function CoordinatorPlacementRow({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const environment = useEnvironment(environmentId);
  const manage = useAtomCommand(serverEnvironment.agentMachines, { reportFailure: false });
  const run = useCallback(
    async (request: CoordinatorMoveRequest) => {
      const result = await manage({
        environmentId,
        input: { action: "coordinatorMove", projectId, ...request },
      });
      if (result._tag === "Failure")
        throw new Error(agentMachinesErrorMessage(squashAtomCommandFailure(result)));
      if (!result.value.coordinatorMove)
        throw new Error("This server did not return the coordinator placement.");
      return result.value.coordinatorMove;
    },
    [environmentId, projectId, manage],
  );

  const placement = environment?.serverConfig?.settings.agentPlacement;
  return (
    <SettingsRow
      title="Coordinator runs on"
      control={
        environment?.connection.phase === "connected" && placement ? (
          <CoordinatorPlacementPicker
            key={JSON.stringify([environmentId, projectId])}
            localLabel={environment.label}
            projectKey={JSON.stringify([environmentId, projectId])}
            machines={linkedAgentMachines(placement).filter((machine) => machine.enabled)}
            run={run}
          />
        ) : (
          <span className="text-sm text-muted-foreground">
            Connect to this environment to check placement.
          </span>
        )
      }
    />
  );
}
