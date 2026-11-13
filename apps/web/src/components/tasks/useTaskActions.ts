import type {
  EnvironmentId,
  Task,
  TaskHandoff,
  TaskHome,
  TaskHorizon,
  TaskId,
  TaskLinks,
  TaskPatch,
  TaskRecurrence,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useMemo } from "react";

import { randomUUID } from "~/lib/utils";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

export interface NewTaskInput {
  readonly title: string;
  readonly notes?: string;
  readonly home: TaskHome;
  readonly recurrence?: TaskRecurrence;
  readonly links?: TaskLinks;
  readonly orderKey?: string | null;
}

function newTaskId(): TaskId {
  return randomUUID() as TaskId;
}

function failureMessage(result: unknown, fallback: string): string {
  const error = squashAtomCommandFailure(result as never);
  return error instanceof Error ? error.message : fallback;
}

/**
 * The user's task writes, each reporting its own failure as a toast. Every
 * call resolves to whether the write was accepted.
 */
export function useTaskActions(environmentId: EnvironmentId | null) {
  const create = useAtomCommand(projectEnvironment.createTask, { reportFailure: false });
  const update = useAtomCommand(projectEnvironment.updateTask, { reportFailure: false });
  const remove = useAtomCommand(projectEnvironment.deleteTask, { reportFailure: false });
  const respond = useAtomCommand(projectEnvironment.respondToTaskProposal, {
    reportFailure: false,
  });
  const handOff = useAtomCommand(projectEnvironment.handOffTask, { reportFailure: false });
  const setIntent = useAtomCommand(projectEnvironment.setTaskIntent, { reportFailure: false });

  return useMemo(() => {
    const run = async (
      title: string,
      execute: (environmentId: EnvironmentId) => Promise<{ readonly _tag: string }>,
    ): Promise<boolean> => {
      if (environmentId === null) return false;
      const result = await execute(environmentId);
      if (result._tag === "Success") return true;
      if (isAtomCommandInterrupted(result as never)) return false;
      toastManager.add({
        type: "error",
        title,
        description: failureMessage(result, "Try again in a moment."),
      });
      return false;
    };

    const patch = (task: Pick<Task, "id" | "title">, value: TaskPatch, title?: string) =>
      run(title ?? `Could not update ${task.title}`, (id) =>
        update({ environmentId: id, input: { taskId: task.id, patch: value } }),
      );

    return {
      available: environmentId !== null,
      create: async (input: NewTaskInput): Promise<TaskId | null> => {
        const taskId = newTaskId();
        const ok = await run("Could not add the task", (id) =>
          create({
            environmentId: id,
            input: {
              taskId,
              title: input.title,
              home: input.home,
              ...(input.notes !== undefined ? { notes: input.notes } : {}),
              ...(input.recurrence !== undefined ? { recurrence: input.recurrence } : {}),
              ...(input.links !== undefined ? { links: input.links } : {}),
              ...(input.orderKey !== undefined ? { orderKey: input.orderKey as never } : {}),
            },
          }),
        );
        return ok ? taskId : null;
      },
      patch,
      setCompleted: (task: Task, completed: boolean) =>
        patch(
          task,
          { status: completed ? "completed" : "todo" },
          completed ? `Could not complete ${task.title}` : `Could not reopen ${task.title}`,
        ),
      move: (task: Task, home: TaskHome) => patch(task, { home }, `Could not move ${task.title}`),
      delete: (task: Task) =>
        run(`Could not delete ${task.title}`, (id) =>
          remove({ environmentId: id, input: { taskId: task.id } }),
        ),
      respond: (task: Task, accept: boolean) =>
        run(accept ? `Could not add ${task.title}` : `Could not dismiss ${task.title}`, (id) =>
          respond({ environmentId: id, input: { taskId: task.id, accept } }),
        ),
      handOff: (task: Task, handoff: TaskHandoff | null) =>
        run(`Could not hand off ${task.title}`, (id) =>
          handOff({ environmentId: id, input: { taskId: task.id, handoff } }),
        ),
      setIntent: (horizon: TaskHorizon, startsOn: string, text: string) =>
        run("Could not save the intent", (id) =>
          setIntent({ environmentId: id, input: { horizon, startsOn, text } }),
        ),
    };
  }, [create, environmentId, handOff, remove, respond, setIntent, update]);
}

export type TaskActions = ReturnType<typeof useTaskActions>;
