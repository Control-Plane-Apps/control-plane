/**
 * Lifecycle prompts that keep the Status board honest. Fork-owned and pure.
 * When an agent linked to a workstream stops, settles, finishes or fails, the
 * coordinator is told which rows still claim it is moving, in the tool result
 * or alongside the agent's delivered result.
 *
 * @module statusFreshness
 */
import type { ProjectStatus } from "@t3tools/contracts";

/** Rows still moving (not done, not checked off) that list `agentId`. */
export function openStatusesForAgent(
  statuses: ReadonlyArray<ProjectStatus> | null | undefined,
  agentId: string,
): ReadonlyArray<ProjectStatus> {
  return (statuses ?? []).filter(
    (status) =>
      status.state !== "done" &&
      status.dismissedAt === undefined &&
      (status.agents ?? []).some((id) => id === agentId),
  );
}

export type AgentLifecycleEvent = "stopped" | "settled" | "finished" | "failed";

const EVENT_TEXT: Record<AgentLifecycleEvent, string> = {
  stopped: "This agent was stopped",
  settled: "This agent is settled",
  finished: "This agent finished",
  failed: "This agent's turn failed",
};

/**
 * The prompt to update the rows that list an agent, or undefined when none
 * does. Names each row by title and id so the coordinator can write it.
 */
export function agentStatusReminder(
  statuses: ReadonlyArray<ProjectStatus> | null | undefined,
  agentId: string,
  event: AgentLifecycleEvent,
): string | undefined {
  const rows = openStatusesForAgent(statuses, agentId);
  if (rows.length === 0) return undefined;
  const named = rows
    .map((status) => `"${status.title}" [status:${status.id}] (${status.state})`)
    .join(", ");
  const plural = rows.length > 1;
  return `${EVENT_TEXT[event]}, and ${plural ? "these Status workstreams list" : "Status workstream"} ${named} ${plural ? "it" : "lists it"}. Update ${plural ? "them" : "it"} with cp_status_set now: done, queued or needs-you, or link the agent that takes over. A working row with no agent running shows the user as Stalled.`;
}
