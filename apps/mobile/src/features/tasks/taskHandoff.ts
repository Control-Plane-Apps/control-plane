import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { taskBrief } from "@t3tools/client-runtime/state/projects";
import type { Task, TaskId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect } from "react";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  createNewTaskDraft,
  getComposerDraftSnapshot,
  setComposerDraftText,
} from "../../state/use-composer-drafts";
import { useThreadOutboxMessages } from "../../state/use-thread-outbox";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useMobileTasks, useTaskActions } from "./useMobileTasks";

// Fork-owned. "Hand to agent", as on desktop: the brief goes into the
// coordinator's composer, or into a new agent's draft, for the user to review
// and send. The task links to that thread.

/** The Project a task belongs to, or the one that proposed it. */
export function projectForTask(
  task: Pick<Task, "links" | "proposal">,
  projects: ReadonlyArray<EnvironmentProject>,
): EnvironmentProject | null {
  const projectId = task.links?.projectId ?? task.proposal?.projectId;
  if (projectId === undefined) return null;
  return projects.find((project) => project.id === projectId) ?? null;
}

/** A brief waiting in a new agent's draft for that thread to be created. */
interface PendingHandoff {
  readonly taskId: TaskId;
  readonly brief: string;
  readonly at: string;
}

const pendingHandoffsAtom = Atom.make<ReadonlyArray<PendingHandoff>>([]).pipe(Atom.keepAlive);

/** A draft the user never sends stops waiting after a day. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

function writeBrief(draftKey: string, brief: string) {
  const current = getComposerDraftSnapshot(draftKey).text.trim();
  setComposerDraftText(draftKey, current.length === 0 ? brief : `${current}\n\n${brief}`);
}

export function useHandToAgent() {
  const navigation = useNavigation();
  const { usesSplitView } = useAdaptiveWorkspaceLayout().layout;
  const { environmentId } = useMobileTasks();
  const actions = useTaskActions(environmentId);

  return useCallback(
    async (
      tasks: ReadonlyArray<Task>,
      kind: "coordinator" | "agent",
      project: EnvironmentProject,
    ) => {
      if (tasks.length === 0) return;
      const brief = tasks.map((task) => taskBrief(task)).join("\n\n");
      if (kind === "coordinator") {
        const coordinatorId = project.assistant?.coordinatorThreadId;
        if (coordinatorId === undefined) return;
        writeBrief(scopedThreadKey(project.environmentId, coordinatorId), brief);
        const at = new Date().toISOString();
        for (const task of tasks) {
          void actions.handOff(task, { kind: "coordinator", threadId: coordinatorId, at });
        }
        const params = {
          environmentId: String(project.environmentId),
          threadId: String(coordinatorId),
        };
        if (usesSplitView) navigation.navigate("Thread", params);
        else navigation.dispatch(StackActions.push("Thread", params));
        return;
      }
      const draftKey = createNewTaskDraft({
        environmentId: project.environmentId,
        projectId: project.id,
      });
      setComposerDraftText(draftKey, brief);
      const at = new Date().toISOString();
      const current = appAtomRegistry.get(pendingHandoffsAtom);
      const taskIds = new Set(tasks.map((task) => task.id));
      appAtomRegistry.set(pendingHandoffsAtom, [
        ...current.filter((entry) => !taskIds.has(entry.taskId)),
        ...tasks.map((task) => ({ taskId: task.id, brief: brief.trim(), at })),
      ]);
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: { draftId: draftKey },
      });
    },
    [actions, navigation, usesSplitView],
  );
}

/**
 * Links a task to the agent its brief started once the user sends the draft:
 * the new thread's creation carries the brief through the outbox. Mounted
 * once beside the app shell.
 */
export function TaskHandoffWorker() {
  const pending = useAtomValue(pendingHandoffsAtom);
  const outbox = useThreadOutboxMessages();
  const { environmentId, tasks } = useMobileTasks();
  const actions = useTaskActions(environmentId);
  useEffect(() => {
    if (pending.length === 0 || environmentId === null) return;
    const now = Date.now();
    const remaining: PendingHandoff[] = [];
    for (const entry of pending) {
      const task = tasks.find((candidate) => candidate.id === entry.taskId);
      if (task === undefined || now - Date.parse(entry.at) > PENDING_TTL_MS) continue;
      let threadId: ThreadId | null = null;
      for (const queue of Object.values(outbox)) {
        const match = queue.find(
          (message) =>
            message.creation !== undefined &&
            message.createdAt >= entry.at &&
            message.text.trim().startsWith(entry.brief),
        );
        if (match !== undefined) {
          threadId = match.threadId;
          break;
        }
      }
      if (threadId === null) {
        remaining.push(entry);
        continue;
      }
      void actions.handOff(task, { kind: "agent", threadId, at: new Date().toISOString() });
    }
    if (remaining.length !== pending.length) appAtomRegistry.set(pendingHandoffsAtom, remaining);
  }, [actions, environmentId, outbox, pending, tasks]);
  return null;
}
