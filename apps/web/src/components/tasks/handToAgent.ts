import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { taskBrief } from "@t3tools/client-runtime/state/projects";
import type { Task, TaskId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useThreadShells } from "../../state/entities";
import { useTasks } from "../../state/tasks";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useTaskActions } from "./useTaskActions";

/** A brief written into a new agent's draft, waiting for that thread to exist. */
interface PendingHandoff {
  readonly taskId: TaskId;
  readonly threadId: ThreadId;
  readonly at: string;
}

const usePendingHandoffs = create<{
  readonly pending: ReadonlyArray<PendingHandoff>;
  readonly add: (entry: PendingHandoff) => void;
  readonly remove: (threadId: ThreadId) => void;
}>()(
  persist(
    (set) => ({
      pending: [],
      add: (entry) =>
        set((state) => ({
          pending: [...state.pending.filter((p) => p.taskId !== entry.taskId), entry],
        })),
      remove: (threadId) =>
        set((state) => ({ pending: state.pending.filter((p) => p.threadId !== threadId) })),
    }),
    { name: "cplane:task-pending-handoffs:v1" },
  ),
);

/** A pending handoff older than this is a draft the user never sent. */
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function projectForTask(
  task: Pick<Task, "links" | "proposal">,
  projects: ReadonlyArray<EnvironmentProject>,
): EnvironmentProject | null {
  const projectId = task.links?.projectId ?? task.proposal?.projectId;
  if (projectId === undefined) return null;
  return projects.find((project) => project.id === projectId) ?? null;
}

/**
 * Hands a task to its Project's coordinator (the brief goes into the
 * coordinator's composer) or to a new agent (a new draft with the brief).
 * The user reviews and sends; the task links to that thread.
 */
export function useHandToAgent() {
  const navigate = useNavigate();
  const { environmentId } = useTasks();
  const actions = useTaskActions(environmentId);
  const handleNewThread = useNewThreadHandler();
  const addPending = usePendingHandoffs((state) => state.add);

  return useCallback(
    async (task: Task, kind: "coordinator" | "agent", project: EnvironmentProject) => {
      const brief = taskBrief(task);
      const { setPrompt } = useComposerDraftStore.getState();
      if (kind === "coordinator") {
        const coordinatorId = project.assistant?.coordinatorThreadId;
        if (coordinatorId == null) return;
        const threadRef = scopeThreadRef(project.environmentId, coordinatorId);
        setPrompt(threadRef, brief);
        await actions.handOff(task, {
          kind: "coordinator",
          threadId: coordinatorId,
          at: new Date().toISOString(),
        });
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
        return;
      }
      const created = await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
        forceNew: true,
      });
      if (created === null) return;
      setPrompt(created.draftId, brief);
      addPending({ taskId: task.id, threadId: created.threadId, at: new Date().toISOString() });
    },
    [actions, addPending, handleNewThread, navigate],
  );
}

/**
 * Links a task to the agent thread its brief started, once the user sends the
 * draft and the thread exists. Mounted once beside the app shell.
 */
export function TaskHandoffCoordinator() {
  const pending = usePendingHandoffs((state) => state.pending);
  const remove = usePendingHandoffs((state) => state.remove);
  const threads = useThreadShells();
  const { environmentId, tasks } = useTasks();
  const actions = useTaskActions(environmentId);
  useEffect(() => {
    if (pending.length === 0 || environmentId === null) return;
    const now = Date.now();
    for (const entry of pending) {
      const task = tasks.find((candidate) => candidate.id === entry.taskId);
      if (task === undefined || now - Date.parse(entry.at) > PENDING_TTL_MS) {
        remove(entry.threadId);
        continue;
      }
      if (!threads.some((thread) => thread.id === entry.threadId)) continue;
      remove(entry.threadId);
      void actions.handOff(task, { kind: "agent", threadId: entry.threadId, at: entry.at });
    }
  }, [actions, environmentId, pending, remove, tasks, threads]);
  return null;
}
