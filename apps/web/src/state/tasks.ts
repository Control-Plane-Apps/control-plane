import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, Task, TaskIntent } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";

import { localTaskDate } from "@t3tools/contracts";
import { usePrimaryEnvironmentId } from "./environments";
import { useServerConfigs } from "./entities";
import { environmentShell } from "./shell";

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

/**
 * Tasks live on the primary environment (this machine's server), so one
 * list follows the user across every Project and machine.
 */
export function useTaskEnvironmentId(): EnvironmentId | null {
  const primary = usePrimaryEnvironmentId();
  const config = useServerConfigs().get(primary ?? ("" as EnvironmentId));
  return primary !== null && config?.environment.capabilities.tasks === true ? primary : null;
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
