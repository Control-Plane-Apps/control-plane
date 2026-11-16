import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { AssistantHeader } from "./AssistantHeader";

const noop = () => undefined;

describe("AssistantHeader", () => {
  it("keeps Today, pinned channels and Inbox without channel creation", async () => {
    const onSelect = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <AssistantHeader
          subtitle="Across 3 Projects"
          channels={[
            { id: "today", label: "Today" },
            { id: "weekly", label: "Weekly review" },
          ]}
          selected="today"
          inboxCount={0}
          onSelect={onSelect}
          onOpenMemory={noop}
          rightPanelOpen={false}
        />,
      );
    });
    const buttons = renderer.root.findAllByType("button");
    expect(buttons.some((button) => button.props["aria-label"] === "New channel")).toBe(false);
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
    const tabs = buttons.filter((button) => button.props["aria-pressed"] !== undefined);
    expect(tabs.map((button) => button.children.join(""))).toEqual([
      "Today",
      "Weekly review",
      "Inbox",
    ]);
    await act(async () => {
      tabs[1]!.props.onClick();
      tabs[2]!.props.onClick();
    });
    expect(onSelect.mock.calls).toEqual([["weekly"], ["inbox"]]);
    await act(async () => renderer.unmount());
  });
});

describe("AssistantHeader schedules", () => {
  it("shows Schedules only when the server stores schedules", async () => {
    for (const onOpenSchedules of [noop, undefined]) {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          <AssistantHeader
            subtitle=""
            channels={[]}
            selected="today"
            inboxCount={0}
            onSelect={noop}
            onOpenMemory={noop}
            onOpenSchedules={onOpenSchedules}
            rightPanelOpen
          />,
        );
      });
      expect(
        renderer.root
          .findAllByType("button")
          .some((button) => button.props["aria-label"] === "Schedules"),
      ).toBe(onOpenSchedules !== undefined);
      await act(async () => renderer.unmount());
    }
  });
});
