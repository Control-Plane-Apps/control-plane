import { findGlobalAssistantProject, isProposedTask, type Task } from "@t3tools/contracts";
import { useCallback } from "react";

import { uuidv4 } from "../../lib/uuid";
import { useProjects } from "../../state/entities";
import { handTasksToAssistant } from "./assistantHandoff";
import { useMobileTaskStore } from "./useMobileTasks";

// Fork-owned. Hand to Assistant, as on desktop: the tasks go straight to the
// Assistant as one handoff message and the row's chip turns to "Handed to
// Assistant". Failures alert from the task action.

/** Hands one or several tasks to the Assistant; proposals still waiting are skipped. */
export function useHandToAssistant() {
  // The screen's own actions: with Task Sync, a hand-off first gets the Mac
  // level with the phone's edits, and says so when the Mac is unreachable.
  const { actions } = useMobileTaskStore();
  const projects = useProjects();
  return useCallback(
    async (tasks: ReadonlyArray<Task>): Promise<boolean> => {
      const threadId = findGlobalAssistantProject(projects)?.assistant?.coordinatorThreadId;
      const handed = tasks.filter((task) => !isProposedTask(task));
      if (threadId == null || handed.length === 0) return false;
      return handTasksToAssistant(handed, threadId, actions.handOff, uuidv4());
    },
    [actions, projects],
  );
}
