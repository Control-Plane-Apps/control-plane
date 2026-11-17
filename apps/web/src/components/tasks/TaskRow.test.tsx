import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ mobile: false }));
vi.mock("../../hooks/useMediaQuery", () => ({ useIsMobile: () => state.mobile }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({ setNodeRef: vi.fn(), setActivatorNodeRef: vi.fn() }),
}));
vi.mock("./taskDrag", () => ({ usePrefersReducedMotion: () => true, TASK_DRAG_TRANSITION: null }));
vi.mock("./TaskMenus", () => ({
  TaskMoveMenu: () => null,
  TaskReminderMenu: () => null,
  TaskRepeatMenu: () => null,
}));
vi.mock("../ui/menu", () => ({
  Menu: () => null,
  MenuItem: () => null,
  MenuPopup: () => null,
  MenuSeparator: () => null,
  MenuTrigger: () => null,
}));
const { TaskRow } = await import("./TaskRow");
type Props = ComponentProps<typeof TaskRow>;
const listeners = new Map<string, (event: unknown) => void>();
class Target {
  constructor(
    readonly inside = false,
    readonly portal = false,
  ) {}
  closest() {
    return this.portal ? this : null;
  }
}
let renderer: ReactTestRenderer | undefined;
const ASSISTANT_PROJECT = {
  id: "assistant-home",
  environmentId: "env",
  title: "Assistant",
  assistant: { coordinatorThreadId: "assistant-today", scope: "global" },
};
async function mount(
  expanded = false,
  extra: { projects?: unknown[]; task?: object; selected?: boolean } = {},
) {
  vi.stubGlobal("Element", Target);
  vi.stubGlobal("document", {
    addEventListener: (key: string, listener: (event: unknown) => void) =>
      listeners.set(key, listener),
    removeEventListener: (key: string) => listeners.delete(key),
  });
  const onSelectClick = vi.fn();
  const onToggleExpanded = vi.fn();
  const patch = vi.fn();
  const onHandToAssistant = vi.fn();
  const props = {
    task: {
      id: "synthetic",
      title: "Synthetic task",
      status: "todo",
      home: { kind: "backlog", horizon: null },
      ...extra.task,
    },
    state: { kind: "none" },
    expanded,
    selected: extra.selected,
    onSelectClick,
    onToggleExpanded,
    context: {
      today: "2026-11-16",
      projects: extra.projects ?? [],
      actions: { patch },
      onHandToAssistant,
    },
  } as unknown as Props;
  await act(async () => {
    renderer = create(<TaskRow {...props} />, {
      createNodeMock: () => ({ contains: (target: Target) => target.inside }),
    });
  });
  return { root: renderer!.root, onSelectClick, onToggleExpanded, patch, onHandToAssistant };
}
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.mobile = false;
  listeners.clear();
  vi.unstubAllGlobals();
});

describe("TaskRow desktop interactions", () => {
  it("pads a neutral selected surface inside the row", async () => {
    const { root } = await mount(false, { selected: true });
    const row = root.findByType("li");
    expect(row.props["data-selected"]).toBe(true);
    expect(row.props.className).not.toContain("bg-");
    const surface = row.findAllByType("div")[0]!;
    expect(surface.props.className).toContain("px-2 py-2");
    expect(surface.props.className).toContain("rounded-lg");
    expect(surface.props.className).toContain("group-data-[selected=true]/task:bg-accent/30");
    expect(surface.props.className).not.toContain("bg-primary");
  });
  it("replaces selection with the expanded card without a background on its wrapper", async () => {
    const { root } = await mount(true, { selected: true });
    const row = root.findByType("li");
    expect(row.props["data-selected"]).toBeUndefined();
    expect(row.props.className).not.toContain("bg-");
    const surface = row.findAllByType("div")[0]!;
    expect(surface.props.className).toContain("bg-card");
    expect(surface.props.className).not.toContain("selected");
    expect(surface.props.className).not.toContain("highlighted");
  });
  it("selects the title or row whitespace without expanding, then expands on double click", async () => {
    const { root, onSelectClick, onToggleExpanded } = await mount();
    const row = root.findByType("li");
    const event = { target: new Target(), stopPropagation: vi.fn() };
    row.props.onClick(event);
    root.findByProps({ "data-task-title": true }).props.onClick(event);
    expect(onSelectClick).toHaveBeenCalledTimes(2);
    expect(onToggleExpanded).not.toHaveBeenCalled();
    row.props.onDoubleClick(event);
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
    expect(onSelectClick).toHaveBeenCalledTimes(2);
  });
  it("keeps mobile tap-to-open", async () => {
    state.mobile = true;
    const { root, onSelectClick, onToggleExpanded } = await mount();
    root.findByProps({ "data-task-title": true }).props.onClick({ stopPropagation: vi.fn() });
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
    expect(onSelectClick).not.toHaveBeenCalled();
  });
  it("collapses outside the expanded box while leaving row and portaled menu interactions alone", async () => {
    const { onToggleExpanded } = await mount(true);
    listeners.get("click")?.({ target: new Target(true) });
    listeners.get("click")?.({ target: new Target(false, true) });
    expect(onToggleExpanded).not.toHaveBeenCalled();
    listeners.get("click")?.({ target: new Target() });
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });
  it("cancels a title edit on Escape without saving its draft on blur", async () => {
    const { root, patch } = await mount(true);
    const input = root.findByProps({ "aria-label": "Task title" });
    await act(async () => input.props.onChange({ target: { value: "Unsaved draft" } }));
    await act(async () =>
      input.props.onKeyDown({
        key: "Escape",
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        currentTarget: { blur: () => input.props.onBlur() },
      }),
    );
    expect(patch).not.toHaveBeenCalled();
    expect(input.props.value).toBe("Synthetic task");
  });
  it("offers one plain Hand to Assistant chip that sends the task, with no agent menu", async () => {
    const { root, onHandToAssistant } = await mount(true, { projects: [ASSISTANT_PROJECT] });
    const buttons = root.findAll(
      (node) => node.type === "button" && node.props.children === "Hand to Assistant",
    );
    expect(buttons).toHaveLength(1);
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).not.toContain("Hand to agent");
    expect(text).not.toContain("coordinator");
    buttons[0]!.props.onClick();
    expect(onHandToAssistant).toHaveBeenCalledWith(expect.objectContaining({ id: "synthetic" }));
  });
  it("reads Handed to Assistant once it is there, and hides without an Assistant", async () => {
    const handed = await mount(true, {
      projects: [ASSISTANT_PROJECT],
      task: { handoff: { kind: "coordinator", threadId: "assistant-today", at: "x" } },
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Handed to Assistant");
    expect(
      handed.root.findAll(
        (node) => node.type === "button" && node.props.children === "Hand to Assistant",
      ),
    ).toHaveLength(0);
    await act(async () => renderer?.unmount());
    await mount(true);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Assistant");
  });
});
