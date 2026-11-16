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
});
