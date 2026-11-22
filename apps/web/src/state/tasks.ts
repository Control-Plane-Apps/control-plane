import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId, Task, TaskIntent } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";

import { localTaskDate } from "@t3tools/contracts";
import { environmentCatalog } from "../connection/catalog";
import { useEnvironment } from "./environments";
import { serverEnvironment } from "./server";
import { environmentShell } from "./shell";
import {
  readRememberedTaskEnvironmentId,
  rememberTaskEnvironmentId,
  resolveTaskEnvironmentId,
  type TaskEnvironmentCandidate,
} from "./taskEnvironment";

const EMPTY_TASKS: ReadonlyArray<Task> = Object.freeze([]);
const EMPTY_INTENTS: ReadonlyArray<TaskIntent> = Object.freeze([]);

const EMPTY_TASK_STATE_ATOM = Atom.make({
  tasks: EMPTY_TASKS,
  intents: EMPTY_INTENTS,
}).pipe(Atom.withLabel("web-tasks:empty"));

const taskStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const snapshot = get(environmentShell.stateValueAtom(environmentId)).snapshot;
    if (Option.isNone(snapshot)) return { tasks: EMPTY_TASKS, intents: EMPTY_INTENTS };
    return {
      tasks: snapshot.value.tasks ?? EMPTY_TASKS,
      intents: snapshot.value.taskIntents ?? EMPTY_INTENTS,
    };
  }).pipe(Atom.withLabel(`web-tasks:${environmentId}`)),
);

let rememberedTaskEnvironmentId: EnvironmentId | null | undefined;

/**
 * The server that holds Tasks for this client. Usually this machine's own
 * server, but a client attached to another machine's server uses that
 * server's list (see resolveTaskEnvironmentId). The last resolution is
 * remembered so Tasks stays put, in a reconnecting state, while that server
 * is offline.
 */
export const taskEnvironmentIdAtom = Atom.make((get): EnvironmentId | null => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const candidates: TaskEnvironmentCandidate[] = [];
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    const entry = catalog.entries.get(environmentId);
    const config = get(serverEnvironment.configValueAtom(environmentId));
    const snapshot = get(environmentShell.stateValueAtom(environmentId)).snapshot;
    candidates.push({
      environmentId,
      isPrimary: entry?.target._tag === "PrimaryConnectionTarget",
      supportsTasks: config === null ? null : config.environment.capabilities.tasks === true,
      defersTasks: config?.environment.capabilities.tasksDeferred === true,
      taskRecordCount: Option.isSome(snapshot)
        ? (snapshot.value.tasks?.length ?? 0) + (snapshot.value.taskIntents?.length ?? 0)
        : 0,
    });
  }
  if (rememberedTaskEnvironmentId === undefined) {
    rememberedTaskEnvironmentId = readRememberedTaskEnvironmentId();
  }
  const resolved = resolveTaskEnvironmentId({
    candidates,
    rememberedEnvironmentId: rememberedTaskEnvironmentId,
  });
  if (resolved !== null && resolved !== rememberedTaskEnvironmentId) {
    rememberedTaskEnvironmentId = resolved;
    rememberTaskEnvironmentId(resolved);
  }
  return resolved;
}).pipe(Atom.withLabel("web-tasks:environment-id"));

export function useTaskEnvironmentId(): EnvironmentId | null {
  return useAtomValue(taskEnvironmentIdAtom);
}

export interface TaskEnvironmentStatus {
  /** Whether the Tasks server is live. Edits made while it is not are rejected. */
  readonly connected: boolean;
  readonly phase: EnvironmentConnectionPhase | null;
  /** The Tasks server's name when it is another machine, else null. */
  readonly remoteLabel: string | null;
}

/** Connection state of the server that holds Tasks, for reconnecting UI. */
export function useTaskEnvironmentStatus(): TaskEnvironmentStatus {
  const environment = useEnvironment(useTaskEnvironmentId());
  const phase = environment?.connection.phase ?? null;
  return {
    connected: phase === "connected",
    phase,
    remoteLabel:
      environment !== null && environment.entry.target._tag !== "PrimaryConnectionTarget"
        ? environment.label
        : null,
  };
}

export function useTasks(): {
  readonly environmentId: EnvironmentId | null;
  readonly tasks: ReadonlyArray<Task>;
  readonly intents: ReadonlyArray<TaskIntent>;
} {
  const environmentId = useTaskEnvironmentId();
  const state = useAtomValue(
    environmentId === null ? EMPTY_TASK_STATE_ATOM : taskStateAtom(environmentId),
  );
  return { environmentId, ...state };
}

const DAY_CHECK_MS = 60_000;

/** The local calendar day, rolling over at midnight. */
export function useTaskToday(): string {
  const [today, setToday] = useState(() => localTaskDate(Date.now()));
  useEffect(() => {
    const interval = window.setInterval(() => setToday(localTaskDate(Date.now())), DAY_CHECK_MS);
    return () => window.clearInterval(interval);
  }, []);
  return today;
}
