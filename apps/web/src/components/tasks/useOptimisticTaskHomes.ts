import {
  applyTaskHomeOverrides,
  overridesAfterWrite,
  settleTaskHomeOverrides,
  type TaskHomeOverride,
  type TaskHomeOverrides,
} from "@t3tools/client-runtime/state/projects";
import type { Task, TaskHome } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";

import type { TaskActions } from "./useTaskActions";

const NO_OVERRIDES: TaskHomeOverrides = new Map();

/**
 * Moves between days and periods that show at once. A dropped task takes its
 * new home the moment it is released, the write goes out in the background,
 * and a failed write puts the task back where the server has it (the failure
 * already toasted). Matches the reorder drag, which also shows its result
 * before the server agrees (TaskList).
 */
export function useOptimisticTaskHomes(tasks: ReadonlyArray<Task>, actions: TaskActions) {
  const [overrides, setOverrides] = useState<TaskHomeOverrides>(NO_OVERRIDES);
  // Saved moves give way once the server's tasks catch up.
  const settled = settleTaskHomeOverrides(overrides, tasks);
  if (settled !== overrides) setOverrides(settled);
  const shown = useMemo(() => applyTaskHomeOverrides(tasks, settled), [tasks, settled]);

  const move = useCallback(
    async (task: Task, home: TaskHome) => {
      const written: TaskHomeOverride = {
        home,
        baseUpdatedAt: task.updatedAt,
        status: "saving",
      };
      setOverrides((current) => new Map(current).set(task.id, written));
      const accepted = await actions.move(task, home);
      setOverrides((current) => overridesAfterWrite(current, task.id, written, accepted));
      return accepted;
    },
    [actions],
  );

  return { tasks: shown, move };
}
