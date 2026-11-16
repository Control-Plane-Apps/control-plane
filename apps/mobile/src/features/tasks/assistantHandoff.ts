import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { sendDeliveredHandoff } from "@t3tools/client-runtime/state/projects";
import { isGlobalAssistant, type Task, type TaskHandoff, type ThreadId } from "@t3tools/contracts";

import type { TaskActions } from "./useMobileTasks";

// Fork-owned. Hand to Assistant on iOS: no draft to review, the tasks go
// straight to the Assistant as one handoff message, as on desktop.

/** The Assistant thread a coordinator handoff to `project` sends to, or null for any other target. */
export function assistantHandoffThread(
  kind: "coordinator" | "agent",
  project: Pick<EnvironmentProject, "assistant">,
): ThreadId | null {
  if (kind !== "coordinator" || !isGlobalAssistant(project)) return null;
  return project.assistant?.coordinatorThreadId ?? null;
}

/** Links each task to the Assistant and sends the batch there as one message. */
export function handTasksToAssistant(
  tasks: ReadonlyArray<Task>,
  threadId: ThreadId,
  handOff: TaskActions["handOff"],
  uuid: string,
  at: string = new Date().toISOString(),
): Promise<boolean> {
  return sendDeliveredHandoff(tasks, threadId, at, uuid, handOff);
}

/** The handed-off chip: the Assistant, a Project's coordinator, or an agent thread. */
export function handoffChipLabel(
  handoff: Pick<TaskHandoff, "kind" | "threadId">,
  assistantThreadId: string | null | undefined,
  projectTitle: string,
): string {
  if (assistantThreadId != null && handoff.threadId === assistantThreadId) {
    return "Handed to Assistant";
  }
  return handoff.kind === "coordinator" ? `${projectTitle} coordinator` : "Agent thread";
}
