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
import { presentConnectionState } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert, AppState } from "react-native";

import { uuidv4 } from "../../lib/uuid";
import { environmentCatalog } from "../../connection/catalog";
import { useProjects, useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { cloudTaskStore, type CloudTaskSnapshot } from "./cloudTasks";

// Fork-owned. The one place the mobile Tasks UI reads and writes personal
// tasks. With the paired Mac connected they come from its shell snapshot and
// are written with the task.* orchestration commands. With the Mac asleep and
// the phone signed in to Task Sync they come from the phone's own cloud copy
// (cloudTasks.ts); links, proposals and hand-offs still come from the Mac.

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

const EMPTY_CONNECTION_STATE_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("mobile-tasks:connection:empty"),
);

/** Whether the paired Mac that holds tasks is reachable right now. */
function useMacConnected(environmentId: EnvironmentId | null): boolean {
  const state = useAtomValue(
    environmentId === null
      ? EMPTY_CONNECTION_STATE_ATOM
      : environmentCatalog.stateAtom(environmentId),
  );
  const value = Option.getOrNull(AsyncResult.value(state));
  return value !== null && presentConnectionState(value).phase === "connected";
}

/** The phone's own cloud copy of the task list and its Task Sync status. */
export function useCloudTasks(): CloudTaskSnapshot {
  const store = cloudTaskStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

function cloudSignedIn(snapshot: CloudTaskSnapshot): boolean {
  const state = snapshot.status?.state;
  return state === "synced" || state === "syncing" || state === "error";
}

/** Cloud records with the Mac's Control Plane-only fields laid back on. */
function withMacFields(cloud: ReadonlyArray<Task>, mac: ReadonlyArray<Task>): ReadonlyArray<Task> {
  const macById = new Map(mac.map((task) => [task.id as string, task]));
  return cloud.map((task) => {
    const known = macById.get(task.id);
    if (known === undefined) return task;
    return {
      ...task,
      ...(known.links !== undefined ? { links: known.links } : {}),
      ...(known.handoff !== undefined ? { handoff: known.handoff } : {}),
    };
  });
}

export type MobileTaskSource = "mac" | "cloud";

export interface MobileTasks {
  readonly environmentId: EnvironmentId | null;
  /** Where the list comes from: the paired Mac, or the phone's cloud copy while the Mac sleeps. */
  readonly source: MobileTaskSource;
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
  const macConnected = useMacConnected(environmentId);
  const cloud = useCloudTasks();
  const useCloud = !macConnected && cloudSignedIn(cloud);
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      environmentId === null
        ? []
        : allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const cloudTasks = useMemo(
    () => (useCloud ? withMacFields(cloud.tasks, state.tasks) : EMPTY_TASKS),
    [cloud.tasks, state.tasks, useCloud],
  );
  if (useCloud) {
    return {
      environmentId,
      source: "cloud",
      available: true,
      tasks: cloudTasks,
      intents: cloud.intents,
      projects,
    };
  }
  return {
    environmentId,
    source: "mac",
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
export function useTaskActions(
  environmentId: EnvironmentId | null,
  source: MobileTaskSource = "mac",
) {
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

    if (source === "cloud") return cloudActions();
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
  }, [create, environmentId, handOff, remove, respond, setIntent, update, source]);
}

const NEEDS_MAC = "Your Mac needs to be awake for this. Your other task changes sync now.";

/** Writes straight to the phone's cloud copy while the Mac sleeps. */
function cloudActions() {
  const store = cloudTaskStore();
  const guarded = async (title: string, run: () => Promise<unknown>): Promise<boolean> => {
    try {
      const result = await run();
      return result !== false;
    } catch {
      Alert.alert(title, "Try again in a moment.");
      return false;
    }
  };
  const patch = (task: Pick<Task, "id" | "title">, value: TaskPatch, title?: string) =>
    guarded(title ?? `Could not update ${task.title}`, () => store.patch(task.id, value));
  return {
    available: true,
    create: async (input: NewTaskInput): Promise<TaskId | null> => {
      const taskId = uuidv4() as TaskId;
      const ok = await guarded("Could not add the task", () =>
        store.create({
          id: taskId,
          title: input.title,
          home: input.home,
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.recurrence !== undefined ? { recurrence: input.recurrence } : {}),
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
      guarded(`Could not delete ${task.title}`, () => store.delete(task.id)),
    respond: async (task: Pick<Task, "id" | "title">, _accept: boolean) => {
      Alert.alert(`Could not answer ${task.title}`, NEEDS_MAC);
      return false;
    },
    handOff: async (task: Pick<Task, "id" | "title">, _handoff: TaskHandoff | null) => {
      Alert.alert(`Could not hand off ${task.title}`, NEEDS_MAC);
      return false;
    },
    setIntent: (horizon: TaskHorizon, startsOn: string, text: string) =>
      guarded("Could not save the intent", () => store.setIntent(horizon, startsOn, text)),
  };
}

export type TaskActions = ReturnType<typeof useTaskActions>;

/** Tasks plus their writes, for screens. */
export function useMobileTaskStore() {
  const source = useMobileTasks();
  const actions = useTaskActions(source.environmentId, source.source);
  return { ...source, actions };
}

export interface TaskSyncAccount {
  /** The service hasn't switched Task Sync on yet. */
  readonly comingSoon: boolean;
  /** Signed in to the Control Plane account that syncs tasks. */
  readonly signedIn: boolean;
  /** The account's email when signed in. */
  readonly email: string | null;
}

/** Whether this phone is signed in to the Control Plane account tasks sync through. */
export function useTaskSyncAccount(): TaskSyncAccount {
  const { status } = useCloudTasks();
  const signedIn =
    status !== null &&
    status.state !== "signed-out" &&
    status.state !== "unavailable" &&
    status.state !== "coming-soon";
  return {
    comingSoon: status?.state === "coming-soon",
    signedIn,
    email: signedIn ? (status.account?.email ?? null) : null,
  };
}
