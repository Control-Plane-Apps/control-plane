import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  getTaskWeekStartsOn,
  localTaskDate,
  setTaskWeekStartsOn,
  type EnvironmentId,
  type Task,
  type TaskDeleteScope,
  type TaskHandoff,
  type TaskHome,
  type TaskHorizon,
  type TaskId,
  type TaskIntent,
  type TaskPatch,
  type TaskSyncStatus,
} from "@t3tools/contracts";
import { presentConnectionState } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AppState } from "react-native";

import type { HandoffDelivery } from "@t3tools/client-runtime/state/projects";
import { uuidv4 } from "../../lib/uuid";
import { environmentCatalog } from "../../connection/catalog";
import { useProjects, useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { cloudTaskStore, type CloudTaskSnapshot } from "./cloudTasks";
import {
  cloudTaskSourceActive,
  layerMacFields,
  makeCloudTaskActions,
  NEEDS_MAC_MESSAGE,
  selectTaskSource,
  type MacTaskBridge,
  type MobileTaskSource,
  type NewTaskInput,
} from "./taskSource";

// Fork-owned. The one place the mobile Tasks UI reads and writes personal
// tasks. Signed in to Task Sync, the phone's own cloud copy (cloudTasks.ts) is
// the source of truth for tasks and intents, Mac connected or not: reads and
// writes go there, offline-capable. The paired Mac only adds links, proposals
// and hand-offs (taskSource.ts). Without Task Sync, the Mac's shell snapshot
// is the list and writes are the task.* orchestration commands, as before.

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

export type { MobileTaskSource, NewTaskInput };

export interface MobileTasks {
  readonly environmentId: EnvironmentId | null;
  /** Where the list comes from: the phone's Task Sync copy, or the paired Mac without it. */
  readonly source: MobileTaskSource;
  /** Whether the paired Mac is reachable now (it alone holds links, hand-offs, proposals). */
  readonly macConnected: boolean;
  readonly available: boolean;
  readonly tasks: ReadonlyArray<Task>;
  readonly intents: ReadonlyArray<TaskIntent>;
  /** The Mac's own tasks (its last snapshot), for the Mac-only fields. */
  readonly macTasks: ReadonlyArray<Task>;
  /** Projects of the task environment, for chips, filters and hand-offs. */
  readonly projects: ReadonlyArray<EnvironmentProject>;
}

/**
 * With the Mac as the source, its intents are keyed by the account's week
 * start, which only the Mac's Task Sync status carries. Reading it here keeps
 * the phone's weeks on the same day. With the phone's own copy, its engine
 * sets the week start and the Mac is not asked.
 */
function useMacWeekStart(environmentId: EnvironmentId | null, enabled: boolean): void {
  const readStatus = useAtomCommand(projectEnvironment.taskSyncStatus, { reportFailure: false });
  const [, setWeekStart] = useState(getTaskWeekStartsOn());
  useEffect(() => {
    if (environmentId === null || !enabled) return;
    let cancelled = false;
    void readStatus({ environmentId, input: undefined as never }).then((result) => {
      if (cancelled || result._tag !== "Success") return;
      const { weekStartsOn } = result.value as TaskSyncStatus;
      if (weekStartsOn === getTaskWeekStartsOn()) return;
      setTaskWeekStartsOn(weekStartsOn);
      // Weeks are read from the shared setting at render; render again.
      setWeekStart(getTaskWeekStartsOn());
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, enabled, readStatus]);
}

export function useMobileTasks(): MobileTasks {
  const environmentId = useTaskEnvironmentId();
  const state = useAtomValue(
    environmentId === null ? EMPTY_TASK_STATE_ATOM : taskStateAtom(environmentId),
  );
  const macConnected = useMacConnected(environmentId);
  const cloud = useCloudTasks();
  // Only Task Sync picks the source; the Mac connecting or dropping never switches it.
  const source = selectTaskSource(cloudTaskSourceActive(cloud.status, cloud.savedAccount));
  useMacWeekStart(environmentId, source === "mac" && macConnected);
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      environmentId === null
        ? []
        : allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const cloudTasks = useMemo(
    () => (source === "cloud" ? layerMacFields(cloud.tasks, state.tasks) : EMPTY_TASKS),
    [cloud.tasks, state.tasks, source],
  );
  if (source === "cloud") {
    return {
      environmentId,
      source,
      macConnected,
      available: true,
      tasks: cloudTasks,
      intents: cloud.intents,
      macTasks: state.tasks,
      projects,
    };
  }
  return {
    environmentId,
    source,
    macConnected,
    available: environmentId !== null,
    tasks: state.tasks,
    intents: state.intents,
    macTasks: state.tasks,
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

function failureMessage(result: unknown, fallback: string): string {
  const error = squashAtomCommandFailure(result as never);
  return error instanceof Error ? error.message : fallback;
}

/** How long a Mac-only write waits for the Mac to pull a task the phone just pushed. */
const MAC_CATCH_UP_MS = 4_000;
const MAC_POLL_MS = 200;

const NO_MAC: { readonly connected: boolean; readonly tasks: ReadonlyArray<Task> } = {
  connected: false,
  tasks: EMPTY_TASKS,
};

/**
 * The user's task writes. Each reports its own failure as an alert and
 * resolves to whether the write was accepted.
 */
export function useTaskActions(
  environmentId: EnvironmentId | null,
  source: MobileTaskSource,
  mac: { readonly connected: boolean; readonly tasks: ReadonlyArray<Task> } = NO_MAC,
) {
  const create = useAtomCommand(projectEnvironment.createTask, { reportFailure: false });
  const update = useAtomCommand(projectEnvironment.updateTask, { reportFailure: false });
  const remove = useAtomCommand(projectEnvironment.deleteTask, { reportFailure: false });
  const respond = useAtomCommand(projectEnvironment.respondToTaskProposal, {
    reportFailure: false,
  });
  const handOff = useAtomCommand(projectEnvironment.handOffTask, { reportFailure: false });
  const setIntent = useAtomCommand(projectEnvironment.setTaskIntent, { reportFailure: false });
  const macSyncNow = useAtomCommand(projectEnvironment.taskSyncNow, { reportFailure: false });
  // The Mac's latest snapshot, read by a write that waits for the Mac to catch up.
  const macTasksRef = useRef(mac.tasks);
  useEffect(() => {
    macTasksRef.current = mac.tasks;
  }, [mac.tasks]);
  const macKnows = useCallback(
    (taskId: TaskId) => macTasksRef.current.some((task) => task.id === taskId),
    [],
  );
  const macConnected = mac.connected;

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

    const outcome = async (
      execute: (environmentId: EnvironmentId) => Promise<{ readonly _tag: string }>,
    ) => {
      if (environmentId === null) return { ok: false as const, message: NEEDS_MAC_MESSAGE };
      const result = await execute(environmentId);
      if (result._tag === "Success") return { ok: true as const };
      if (isAtomCommandInterrupted(result as never)) return { ok: false as const };
      return { ok: false as const, message: failureMessage(result, "Try again in a moment.") };
    };

    const sendHandOff = (
      id: EnvironmentId,
      taskId: TaskId,
      handoff: TaskHandoff | null,
      delivery?: HandoffDelivery,
    ) =>
      handOff({
        environmentId: id,
        input: {
          taskId,
          handoff,
          ...(delivery !== undefined
            ? { commandId: delivery.commandId, deliver: { taskIds: delivery.taskIds } }
            : {}),
        },
      });

    if (source === "cloud") {
      const knows = macKnows;
      const bridge: MacTaskBridge = {
        connected: environmentId !== null && macConnected,
        knows,
        syncNow: async () => {
          if (environmentId === null) return;
          await macSyncNow({ environmentId, input: undefined as never });
        },
        waitFor: async (taskId) => {
          for (let waited = 0; waited < MAC_CATCH_UP_MS; waited += MAC_POLL_MS) {
            if (knows(taskId)) return true;
            await new Promise((resolve) => setTimeout(resolve, MAC_POLL_MS));
          }
          return knows(taskId);
        },
        update: (taskId, value) =>
          outcome((id) => update({ environmentId: id, input: { taskId, patch: value } })),
        remove: (taskId, scope) =>
          outcome((id) =>
            remove({
              environmentId: id,
              input: { taskId, ...(scope !== undefined ? { scope } : {}) },
            }),
          ),
        respond: (taskId, accept) =>
          outcome((id) => respond({ environmentId: id, input: { taskId, accept } })),
        handOff: (taskId, handoff, delivery) =>
          outcome((id) => sendHandOff(id, taskId, handoff, delivery)),
      };
      return makeCloudTaskActions({
        cloud: cloudTaskStore(),
        mac: bridge,
        alert: (title, message) => Alert.alert(title, message),
        newId: () => uuidv4() as TaskId,
      });
    }

    const patch = (task: Pick<Task, "id" | "title">, value: TaskPatch, title?: string) =>
      run(title ?? `Could not update ${task.title}`, (id) =>
        update({ environmentId: id, input: { taskId: task.id, patch: value } }),
      );

    return {
      available: environmentId !== null,
      /** The Mac is the source here: everything goes through it. */
      macReachable: environmentId !== null,
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
      delete: (task: Pick<Task, "id" | "title">, scope?: TaskDeleteScope) =>
        run(`Could not delete ${task.title}`, (id) =>
          remove({
            environmentId: id,
            input: { taskId: task.id, ...(scope !== undefined ? { scope } : {}) },
          }),
        ),
      respond: (task: Pick<Task, "id" | "title">, accept: boolean) =>
        run(accept ? `Could not add ${task.title}` : `Could not dismiss ${task.title}`, (id) =>
          respond({ environmentId: id, input: { taskId: task.id, accept } }),
        ),
      handOff: (
        task: Pick<Task, "id" | "title">,
        handoff: TaskHandoff | null,
        delivery?: HandoffDelivery,
      ) =>
        run(`Could not hand off ${task.title}`, (id) =>
          sendHandOff(id, task.id, handoff, delivery),
        ),
      setIntent: (horizon: TaskHorizon, startsOn: string, text: string) =>
        run("Could not save the intent", (id) =>
          setIntent({ environmentId: id, input: { horizon, startsOn, text } }),
        ),
    };
  }, [
    create,
    environmentId,
    handOff,
    macConnected,
    macKnows,
    macSyncNow,
    remove,
    respond,
    setIntent,
    source,
    update,
  ]);
}

export type TaskActions = ReturnType<typeof useTaskActions>;

/** Tasks plus their writes, for screens. */
export function useMobileTaskStore() {
  const source = useMobileTasks();
  const actions = useTaskActions(source.environmentId, source.source, {
    connected: source.macConnected,
    tasks: source.macTasks,
  });
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
