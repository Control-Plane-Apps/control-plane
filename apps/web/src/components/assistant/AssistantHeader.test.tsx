import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

// Base UI's tooltip reads `window` on mount, which the node test environment lacks.
vi.mock("../ui/tooltip", () => ({
  Tooltip: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { render: React.ReactElement; children: React.ReactNode }) => (
    <props.render.type {...(props.render.props as object)}>{props.children}</props.render.type>
  ),
  TooltipPopup: () => null,
}));
const { AssistantHeader } = await import("./AssistantHeader");

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
          description="Talks to every Project coordinator and workspace"
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
          description=""
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

  it("is single-line: the description is not rendered as text under the title", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <AssistantHeader
          description="Talks to every Project coordinator and workspace"
          inboxCount={0}
          inbox={null}
          onInboxOpenChange={noop}
          onOpenMemory={noop}
          rightPanelOpen
        />,
      );
    });
    const title = renderer.root.findByProps({ "data-testid": "assistant-header-title" });
    const text = (node: { children: ReadonlyArray<unknown> }): string =>
      node.children
        .map((child) =>
          typeof child === "string" ? child : text(child as { children: ReadonlyArray<unknown> }),
        )
        .join("");
    expect(text(title)).toBe("Assistant");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Talks to every");
    await act(async () => renderer.unmount());
  });
});
