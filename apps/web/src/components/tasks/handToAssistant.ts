import { sendDeliveredHandoff } from "@t3tools/client-runtime/state/projects";
import { findGlobalAssistantProject, type Task } from "@t3tools/contracts";
import { useCallback } from "react";

import { randomUUID } from "~/lib/utils";
import { useProjects } from "../../state/entities";
import { useTasks } from "../../state/tasks";
import { toastManager } from "../ui/toast";
import { useTaskActions } from "./useTaskActions";

// Fork-owned. Hand to Assistant: the tasks go straight to the Assistant as one
// handoff message (id, title, notes, home, links), queued until it is idle,
// and the Assistant routes them. Each task then reads "Handed to Assistant".

/** Whether the user has an Assistant to hand tasks to. */
export function useHasAssistant(): boolean {
  return findGlobalAssistantProject(useProjects()) !== undefined;
}

/** Hands one or several tasks to the Assistant. Resolves to whether they were sent. */
export function useHandToAssistant() {
  const { environmentId } = useTasks();
  const actions = useTaskActions(environmentId);
  const projects = useProjects();
  return useCallback(
    async (input: Task | readonly Task[]): Promise<boolean> => {
      const tasks: readonly Task[] = Array.isArray(input) ? input : [input as Task];
      const threadId = findGlobalAssistantProject(projects)?.assistant?.coordinatorThreadId;
      if (tasks.length === 0 || threadId == null) return false;
      const sent = await sendDeliveredHandoff(
        tasks,
        threadId,
        new Date().toISOString(),
        randomUUID(),
        actions.handOff,
      );
      if (sent) {
        toastManager.add({
          type: "success",
          title:
            tasks.length === 1
              ? "Handed to Assistant"
              : `Handed ${tasks.length} tasks to Assistant`,
        });
      }
      return sent;
    },
    [actions, projects],
  );
}
