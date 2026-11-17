import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./TaskMenus", () => ({ TaskMoveMenu: () => null }));
const { TaskBulkBar } = await import("./TaskBulkBar");

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

const textOf = (node: { children: ReadonlyArray<unknown> }) =>
  node.children.map((child) => (typeof child === "string" ? child : "")).join("");

function mount(overrides: Partial<Parameters<typeof TaskBulkBar>[0]> = {}) {
  const props = {
    count: 2,
    moveProps: {
      home: { kind: "today" },
      today: "2026-11-17",
      onMove: vi.fn(),
      onPickDate: vi.fn(),
    },
    canHandToAssistant: true,
    onHandToAssistant: vi.fn(),
    onDelete: vi.fn(),
    onClear: vi.fn(),
    ...overrides,
  } as Parameters<typeof TaskBulkBar>[0];
  act(() => {
    renderer = create(<TaskBulkBar {...props} />);
  });
  return { props, root: renderer!.root };
}

describe("TaskBulkBar", () => {
  it("overlays the pane and exposes a labelled clear button", () => {
    const { props, root } = mount();
    const clear = root.findByProps({ "aria-label": "Clear selection" });
    act(() => clear.props.onClick());
    expect(props.onClear).toHaveBeenCalledOnce();
    expect(root.findByProps({ role: "toolbar" }).props["aria-label"]).toBe("Selected task actions");
  });

  it("styles actions as buttons and routes delete and hand-off", () => {
    const { props, root } = mount();
    const buttons = root.findAllByType("button");
    const byText = (text: string) => buttons.find((button) => textOf(button).includes(text))!;
    expect(byText("Delete 2").props.className).toContain("text-destructive");
    act(() => byText("Delete 2").props.onClick());
    act(() => byText("Hand to Assistant").props.onClick());
    expect(props.onDelete).toHaveBeenCalledOnce();
    expect(props.onHandToAssistant).toHaveBeenCalledOnce();
  });

  it("disables hand-off without an assistant project", () => {
    const { root } = mount({ canHandToAssistant: false });
    const hand = root
      .findAllByType("button")
      .find((button) => textOf(button).includes("Hand to Assistant"))!;
    expect(hand.props.disabled).toBe(true);
  });
});
