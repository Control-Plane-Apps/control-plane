import {
  applyTaskHomeOverrides,
  overridesAfterWrite,
  settleTaskHomeOverrides,
  type TaskHomeOverride,
  type TaskHomeOverrides,
} from "@t3tools/client-runtime/state/projects";
import type { Task, TaskHome } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";

// Fork-owned. Moves between days and ranges that show at once: a dropped task
// takes its new home the moment the finger lifts, the write goes out in the
// background, and a failed write puts the task back where the store has it
// (the failure already alerted). Shared logic: client-runtime taskViews.ts.

const NO_OVERRIDES: TaskHomeOverrides = new Map();

export function useOptimisticTaskHomes(
  tasks: ReadonlyArray<Task>,
  moveTask: (task: Task, home: TaskHome) => Promise<boolean>,
) {
  const [overrides, setOverrides] = useState<TaskHomeOverrides>(NO_OVERRIDES);
  const settled = settleTaskHomeOverrides(overrides, tasks);
  if (settled !== overrides) setOverrides(settled);
  const shown = useMemo(() => applyTaskHomeOverrides(tasks, settled), [tasks, settled]);

  const move = useCallback(
    async (task: Task, home: TaskHome) => {
      const written: TaskHomeOverride = { home, baseUpdatedAt: task.updatedAt, status: "saving" };
      setOverrides((current) => new Map(current).set(task.id, written));
      const accepted = await moveTask(task, home);
      setOverrides((current) => overridesAfterWrite(current, task.id, written, accepted));
      return accepted;
    },
    [moveTask],
  );

  return { tasks: shown, move };
}
