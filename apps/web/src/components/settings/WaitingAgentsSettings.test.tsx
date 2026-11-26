import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { WaitingAgent } from "@t3tools/contracts";
import { WaitingAgentsSettings } from "./WaitingAgentsSettings";

const agent: WaitingAgent = {
  threadId: "agent-1",
  title: "Inspect checkout",
  machineId: "mini",
  machineLabel: "Mac Mini",
  branch: "work/inspection",
  commit: "0123456789abcdef0123456789abcdef01234567",
  waitId: "wait-1",
  canResume: false,
  detail: "Reconnect Mac Mini to verify its workspace.",
};

describe("waiting agent controls", () => {
  it("shows the original machine, branch and blocking reason while handoff is unsafe", () => {
    const html = renderToStaticMarkup(
      <WaitingAgentsSettings agents={[agent]} fresh resumingId={null} onResume={vi.fn()} />,
    );
    expect(html).toContain("Mac Mini");
    expect(html).toContain("work/inspection");
    expect(html).toContain("0123456789ab");
    expect(html).toContain(agent.detail);
    expect(html).not.toContain("<button");
  });

  it.each([
    ["prepared", "original machine still owns"],
    ["fencing", "confirming its execution fence"],
    ["fenced", "Destination ownership is pending"],
    ["recovering", "Restoring ownership"],
    ["committed", "Activation is pending"],
  ] as const)("shows durable move phase %s on refresh", (handoffPhase, expected) => {
    expect(
      renderToStaticMarkup(
        <WaitingAgentsSettings
          agents={[{ ...agent, handoffPhase }]}
          fresh
          resumingId={null}
          onResume={vi.fn()}
        />,
      ),
    ).toContain(expected);
  });

  it("explains the prepared copy and original stop before enabling a destination", () => {
    const html = renderToStaticMarkup(
      <WaitingAgentsSettings
        agents={[{ ...agent, destinations: [{ id: "other", label: "Other machine" }] }]}
        fresh
        resumingId={null}
        onResume={vi.fn()}
      />,
    );
    expect(html).toContain("Other machine");
    expect(html).toContain("both machines must be reachable");
    expect(html).toContain("staged changes, unstaged changes and non-ignored untracked files");
    expect(html).toContain("stops and archives");
    expect(html).toContain("Verify and move");
    expect(/<button[^>]*\bdisabled(?:=|\s|>)/.test(html)).toBe(true);
  });

  it("offers recovery before commit and activation after commit", () => {
    const controls = (value: WaitingAgent) =>
      renderToStaticMarkup(
        <WaitingAgentsSettings agents={[value]} fresh resumingId={null} onResume={vi.fn()} />,
      );
    expect(controls({ ...agent, canResume: true, recoveryLabel: "Cancel handoff" })).toContain(
      "Cancel handoff",
    );
    expect(
      controls({ ...agent, canResume: true, recoveryLabel: "Recover original machine" }),
    ).toContain("Recover original machine");
    const committed = controls({ ...agent, activationDestination: "target" });
    expect(committed).toContain("Retry activation");
    expect(committed).not.toContain("Recover original machine");
  });
  it.each([
    { fresh: true, resumingId: null, disabled: false },
    { fresh: false, resumingId: null, disabled: true },
    { fresh: true, resumingId: "agent-1", disabled: true },
  ])(
    "gates a verified resume on the current check and pending action ($fresh, $resumingId)",
    ({ fresh, resumingId, disabled }) => {
      const html = renderToStaticMarkup(
        <WaitingAgentsSettings
          agents={[{ ...agent, canResume: true, detail: "Original checkout verified." }]}
          fresh={fresh}
          resumingId={resumingId}
          onResume={vi.fn()}
        />,
      );
      expect(html).toContain('aria-label="Resume Inspect checkout on Mac Mini"');
      expect(/<button[^>]*\bdisabled(?:=|\s|>)/.test(html)).toBe(disabled);
    },
  );
});
