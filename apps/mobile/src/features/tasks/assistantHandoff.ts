import { sendDeliveredHandoff } from "@t3tools/client-runtime/state/projects";
import type { Task, TaskHandoff, ThreadId } from "@t3tools/contracts";

import type { TaskActions } from "./useMobileTasks";

// Fork-owned. Hand to Assistant on iOS: no draft to review, the tasks go
// straight to the Assistant as one handoff message, as on desktop.

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

/**
 * The Hand to Assistant chip on a task's detail: "offer" a plain chip that
 * sends it, "handed" once the Assistant has it, or null with no Assistant or
 * for a proposal still waiting on the user.
 */
export function assistantChip(
  task: Pick<Task, "handoff" | "proposal">,
  assistantThreadId: string | null,
): "offer" | "handed" | null {
  if (assistantThreadId === null) return null;
  if (task.handoff?.threadId === assistantThreadId) return "handed";
  if (task.proposal !== undefined && task.proposal.acceptedAt === undefined) return null;
  return "offer";
}
