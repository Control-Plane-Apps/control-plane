import type { Task, TaskHandoff, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { assistantChip, handTasksToAssistant, handoffChipLabel } from "./assistantHandoff";

const ASSISTANT = "assistant-today" as ThreadId;
const task = (id: string) => ({ id, title: id }) as unknown as Task;

describe("Hand to Assistant on iOS", () => {
  it("offers one plain chip, says Handed once there, and hides without an Assistant", () => {
    expect(assistantChip({}, ASSISTANT)).toBe("offer");
    expect(
      assistantChip({ handoff: { kind: "coordinator", threadId: ASSISTANT, at: "x" } }, ASSISTANT),
    ).toBe("handed");
    // Handed to a coordinator by an agent: still offered.
    expect(
      assistantChip(
        { handoff: { kind: "coordinator", threadId: "acme-coord" as ThreadId, at: "x" } },
        ASSISTANT,
      ),
    ).toBe("offer");
    expect(
      assistantChip(
        { proposal: { projectId: "p" as never, threadId: "c" as ThreadId, proposedAt: "x" } },
        ASSISTANT,
      ),
    ).toBeNull();
    expect(assistantChip({}, null)).toBeNull();
  });

  it("links every selected task, then sends the batch once on the last", async () => {
    const calls: Array<{ id: string; handoff: TaskHandoff; delivery: unknown }> = [];
    const ok = await handTasksToAssistant(
      [task("a"), task("b"), task("c")],
      ASSISTANT,
      async (entry, handoff, delivery) => {
        calls.push({ id: entry.id, handoff: handoff!, delivery });
        return true;
      },
      "uuid-1",
      "2026-11-16T10:00:00.000Z",
    );
    expect(ok).toBe(true);
    expect(calls.map((call) => call.id)).toEqual(["a", "b", "c"]);
    expect(calls.every((call) => call.handoff.threadId === ASSISTANT)).toBe(true);
    expect(calls.slice(0, 2).map((call) => call.delivery)).toEqual([undefined, undefined]);
    expect(calls[2]!.delivery).toEqual({
      commandId: "cp-send:assistant-today:task-handoff:uuid-1",
      taskIds: ["a", "b", "c"],
    });
  });

  it("sends no message when a handoff fails", async () => {
    const delivered: unknown[] = [];
    const ok = await handTasksToAssistant(
      [task("a"), task("b")],
      ASSISTANT,
      async (entry, _handoff, delivery) => {
        if (delivery !== undefined) delivered.push(delivery);
        return entry.id !== "a";
      },
      "uuid-2",
    );
    expect(ok).toBe(false);
    expect(delivered).toEqual([]);
  });

  it("labels a task handed to the Assistant", () => {
    const at = "2026-11-16T10:00:00.000Z";
    expect(
      handoffChipLabel({ kind: "coordinator", threadId: ASSISTANT }, ASSISTANT, "Assistant"),
    ).toBe("Handed to Assistant");
    expect(
      handoffChipLabel(
        { kind: "coordinator", threadId: "acme-coord" as ThreadId },
        ASSISTANT,
        "Acme",
      ),
    ).toBe("Acme coordinator");
    expect(handoffChipLabel({ kind: "agent", threadId: "x" as ThreadId }, ASSISTANT, "Acme")).toBe(
      "Agent thread",
    );
    void at;
  });
});
