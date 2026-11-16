import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vite-plus/test";

import { AssistantHeader } from "./AssistantHeader";

const noop = () => undefined;

describe("AssistantHeader", () => {
  it.each([
    [0, null],
    [1, "1"],
    [9, "9"],
    [10, "9+"],
    [42, "9+"],
  ])("shows the unread badge for %s pings without a channel switch", async (count, label) => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <AssistantHeader
          subtitle="Talks to every Project coordinator and workspace"
          inboxCount={count as number}
          inbox={<div>Example ping</div>}
          onInboxOpenChange={noop}
          onOpenMemory={noop}
          onOpenSchedules={noop}
          rightPanelOpen={false}
        />,
      );
    });
    const root = renderer.root;
    const buttons = root.findAllByType("button");
    expect(buttons.map((button) => button.props["aria-label"])).toEqual([
      "Inbox",
      "Memory",
      "Schedules",
    ]);
    expect(root.findAllByProps({ role: "group" })).toHaveLength(0);
    expect(root.findAllByType("input")).toHaveLength(0);
    const badges = root.findAllByProps({ "data-testid": "assistant-inbox-badge" });
    expect(badges.map((badge) => badge.children.join(""))).toEqual(label === null ? [] : [label]);
    await act(async () => renderer.unmount());
  });

  it("omits Schedules when the server has none", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <AssistantHeader
          subtitle=""
          inboxCount={0}
          inbox={null}
          onInboxOpenChange={noop}
          onOpenMemory={noop}
          rightPanelOpen
        />,
      );
    });
    expect(
      renderer.root.findAllByType("button").map((button) => button.props["aria-label"]),
    ).toEqual(["Inbox", "Memory"]);
    await act(async () => renderer.unmount());
  });

  it.each([
    [false, 2, "Hide Needs you and Working on", []],
    [true, 0, "Show Needs you and Working on", []],
    [true, 3, "Show Needs you and Working on, 3 need you", ["3"]],
  ])(
    "toggles the rail (collapsed %s, %s needing you)",
    async (collapsed, needsYouCount, label, badges) => {
      let toggled = 0;
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          <AssistantHeader
            subtitle=""
            inboxCount={0}
            inbox={null}
            onInboxOpenChange={noop}
            onOpenMemory={noop}
            rightPanelOpen={false}
            rail={{
              collapsed: collapsed as boolean,
              needsYouCount: needsYouCount as number,
              shortcutLabel: "⌥⌘S",
              onToggle: () => (toggled += 1),
            }}
          />,
        );
      });
      const toggle = renderer.root.findAll(
        (node) => node.type === "button" && node.props["data-testid"] === "assistant-rail-toggle",
      )[0]!;
      expect(toggle.props["aria-label"]).toBe(label);
      expect(
        renderer.root
          .findAllByProps({ "data-testid": "assistant-rail-needs-you-badge" })
          .map((badge) => badge.children.join("")),
      ).toEqual(badges);
      await act(async () => toggle.props.onClick());
      expect(toggled).toBe(1);
      await act(async () => renderer.unmount());
    },
  );
});
