import type { ProjectStatus, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatAgentResult } from "./agentPushes.ts";
import { agentStatusReminder, openStatusesForAgent } from "./statusFreshness.ts";

const AGENT = "thread-pdf" as ThreadId;
const row = (overrides: Partial<ProjectStatus>): ProjectStatus => ({
  id: "pdf",
  title: "Report PDF export",
  state: "working",
  summary: "Photo grids still break.",
  agents: [AGENT],
  updatedAt: "2026-11-16T12:00:00.000Z",
  ...overrides,
});

describe("agentStatusReminder", () => {
  it("names the open rows that list the agent", () => {
    const statuses = [
      row({}),
      row({ id: "fonts", title: "Fonts", state: "queued" }),
      row({ id: "old", title: "Old", state: "done" }),
      row({ id: "other", title: "Other", agents: ["thread-x" as ThreadId] }),
    ];
    expect(openStatusesForAgent(statuses, AGENT).map((status) => status.id)).toEqual([
      "pdf",
      "fonts",
    ]);
    const text = agentStatusReminder(statuses, AGENT, "finished");
    expect(text).toContain("This agent finished");
    expect(text).toContain('"Report PDF export" [status:pdf] (working)');
    expect(text).toContain('"Fonts" [status:fonts] (queued)');
    expect(text).toContain("cp_status_set");
  });

  it("says nothing when no open row lists the agent", () => {
    expect(agentStatusReminder([row({ state: "done" })], AGENT, "stopped")).toBeUndefined();
    expect(agentStatusReminder(undefined, AGENT, "settled")).toBeUndefined();
  });

  it("travels with the agent's delivered result", () => {
    const text = formatAgentResult({
      agentTitle: "PDF agent",
      agentThreadId: AGENT,
      outcome: { kind: "failed", lastError: "boom" },
      text: "Partial.",
      questions: [],
      statusNote: agentStatusReminder([row({})], AGENT, "failed"),
    });
    expect(text.split("\n\n").at(-1)).toMatch(/^Status: This agent's turn failed/);
  });
});
