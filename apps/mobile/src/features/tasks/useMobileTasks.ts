import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  localTaskDate,
  type EnvironmentId,
  type Task,
  type TaskHandoff,
  type TaskHome,
  type TaskHorizon,
  type TaskId,
  type TaskIntent,
  type TaskLinks,
  type TaskPatch,
  type TaskRecurrence,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";
import { Alert, AppState } from "react-native";

import { uuidv4 } from "../../lib/uuid";
import { useProjects, useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

// Fork-owned. The one place the mobile Tasks UI reads and writes personal
// tasks. Today they live on the paired Mac's shell snapshot and are written
// with the task.* orchestration commands; screens only see this module's
// hooks, so the source can move (for example to the cloud task store) without
// touching them.

const EMPTY_TASKS: ReadonlyArray<Task> = Object.freeze([]);
const EMPTY_INTENTS: ReadonlyArray<TaskIntent> = Object.freeze([]);

interface TaskState {
  readonly tasks: ReadonlyArray<Task>;
  readonly intents: ReadonlyArray<TaskIntent>;
}

const EMPTY_TASK_STATE_ATOM = Atom.make<TaskState>({
  tasks: EMPTY_TASKS,
  intents: EMPTY_INTENTS,
}).pipe(Atom.withLabel("mobile-tasks:empty"));

const taskStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): TaskState => {
    const snapshot = get(environmentShell.stateValueAtom(environmentId)).snapshot;
    if (Option.isNone(snapshot)) return { tasks: EMPTY_TASKS, intents: EMPTY_INTENTS };
    return {
      tasks: snapshot.value.tasks ?? EMPTY_TASKS,
      intents: snapshot.value.taskIntents ?? EMPTY_INTENTS,
    };
  }).pipe(Atom.withLabel(`mobile-tasks:${environmentId}`)),
);

/**
 * The environment that holds the task list: the first paired server that
 * stores tasks. One list follows the user across every Project.
 */
export function useTaskEnvironmentId(): EnvironmentId | null {
  const configs = useServerConfigs();
  return useMemo(() => {
    for (const [environmentId, config] of configs) {
      if (config.environment.capabilities.tasks === true) return environmentId;
    }
    return null;
  }, [configs]);
}

export interface MobileTasks {
  readonly environmentId: EnvironmentId | null;
  readonly available: boolean;
  readonly tasks: ReadonlyArray<Task>;
  readonly intents: ReadonlyArray<TaskIntent>;
  /** Projects of the task environment, for chips, filters and hand-offs. */
  readonly projects: ReadonlyArray<EnvironmentProject>;
}

export function useMobileTasks(): MobileTasks {
  const environmentId = useTaskEnvironmentId();
  const state = useAtomValue(
    environmentId === null ? EMPTY_TASK_STATE_ATOM : taskStateAtom(environmentId),
  );
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      environmentId === null
        ? []
        : allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  return {
    environmentId,
    available: environmentId !== null,
    tasks: state.tasks,
    intents: state.intents,
    projects,
  };
}

const DAY_CHECK_MS = 60_000;

/** The local calendar day, rolling over at midnight and on foreground. */
export function useTaskToday(): string {
  const [today, setToday] = useState(() => localTaskDate(Date.now()));
  useEffect(() => {
    const refresh = () => setToday(localTaskDate(Date.now()));
    const interval = setInterval(refresh, DAY_CHECK_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, []);
  return today;
}

export interface NewTaskInput {
  readonly title: string;
  readonly notes?: string;
  readonly home: TaskHome;
  readonly recurrence?: TaskRecurrence;
  readonly links?: TaskLinks;
}

function failureMessage(result: unknown, fallback: string): string {
  const error = squashAtomCommandFailure(result as never);
  return error instanceof Error ? error.message : fallback;
}

/**
 * The user's task writes. Each reports its own failure as an alert and
 * resolves to whether the write was accepted.
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
      Alert.alert(title, failureMessage(result, "Try again in a moment."));
      return false;
    };

    const patch = (task: Pick<Task, "id" | "title">, value: TaskPatch, title?: string) =>
      run(title ?? `Could not update ${task.title}`, (id) =>
        update({ environmentId: id, input: { taskId: task.id, patch: value } }),
      );

    return {
      available: environmentId !== null,
      create: async (input: NewTaskInput): Promise<TaskId | null> => {
        const taskId = uuidv4() as TaskId;
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
            },
          }),
        );
        return ok ? taskId : null;
      },
      patch,
      setCompleted: (task: Pick<Task, "id" | "title">, completed: boolean) =>
        patch(
          task,
          { status: completed ? "completed" : "todo" },
          completed ? `Could not complete ${task.title}` : `Could not reopen ${task.title}`,
        ),
      move: (task: Pick<Task, "id" | "title">, home: TaskHome) =>
        patch(task, { home }, `Could not move ${task.title}`),
      delete: (task: Pick<Task, "id" | "title">) =>
        run(`Could not delete ${task.title}`, (id) =>
          remove({ environmentId: id, input: { taskId: task.id } }),
        ),
      respond: (task: Pick<Task, "id" | "title">, accept: boolean) =>
        run(accept ? `Could not add ${task.title}` : `Could not dismiss ${task.title}`, (id) =>
          respond({ environmentId: id, input: { taskId: task.id, accept } }),
        ),
      handOff: (task: Pick<Task, "id" | "title">, handoff: TaskHandoff | null) =>
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

/** Tasks plus their writes, for screens. */
export function useMobileTaskStore() {
  const source = useMobileTasks();
  const actions = useTaskActions(source.environmentId);
  return { ...source, actions };
}

export interface TaskSyncAccount {
  /** Signed in to the Control Plane account that syncs tasks. */
  readonly signedIn: boolean;
  /** The account's email when signed in. */
  readonly email: string | null;
}

/**
 * Whether tasks sync through a Control Plane account. The phone has no direct
 * cloud access yet, so this reports signed out until that step lands; tasks
 * still arrive through the paired Mac.
 */
export function useTaskSyncAccount(): TaskSyncAccount {
  return { signedIn: false, email: null };
}
