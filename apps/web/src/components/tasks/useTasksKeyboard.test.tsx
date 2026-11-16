import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useTasksKeyboard, type TasksKeyboardOptions } from "./useTasksKeyboard";

class Target {
  constructor(
    readonly typing = false,
    readonly row: string | null = null,
    readonly menu = false,
  ) {}
  readonly isContentEditable = false;
  closest(selector: string) {
    if (selector === "input,textarea,select") return this.typing ? this : null;
    if (selector === "[data-task-id]") return this.row ? this : null;
    return this.menu ? this : null;
  }
  getAttribute() {
    return this.row;
  }
}

let renderer: ReactTestRenderer;
let listener: (event: KeyboardEvent) => void;
let options: TasksKeyboardOptions;
const removeEventListener = vi.fn();
function Probe() {
  useTasksKeyboard(options);
  return null;
}
function press(key: string, patch: Record<string, unknown> = {}) {
  const event = {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    target: new Target(),
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...patch,
  };
  act(() => listener(event as unknown as KeyboardEvent));
  return event;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("HTMLElement", Target);
  vi.stubGlobal("window", {
    addEventListener: (_name: string, callback: typeof listener) => {
      listener = callback;
    },
    removeEventListener,
  });
  options = {
    expandedId: null,
    selectedIds: ["a"],
    hoveredId: null,
    orderedIds: ["a", "b"],
    isBlocked: () => false,
    onExpand: vi.fn(),
    onClear: vi.fn(),
    onDelete: vi.fn(),
    onNew: vi.fn(),
    onMove: vi.fn(),
  };
  act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Tasks keyboard", () => {
  it("collapses on Escape before clearing selection on a second Escape", () => {
    options = { ...options, expandedId: "a" };
    act(() => renderer.update(<Probe />));
    press("Escape");
    expect(options.onExpand).toHaveBeenCalledWith("a");
    expect(options.onClear).not.toHaveBeenCalled();
    options = { ...options, expandedId: null };
    act(() => renderer.update(<Probe />));
    press("Escape");
    expect(options.onClear).toHaveBeenCalledOnce();
  });

  it("consumes Delete and Backspace for a selection but leaves typing alone", () => {
    expect(press("Delete").preventDefault).toHaveBeenCalledOnce();
    expect(press("Backspace").preventDefault).toHaveBeenCalledOnce();
    expect(options.onDelete).toHaveBeenCalledTimes(2);
    expect(press("Delete", { target: new Target(true) }).preventDefault).not.toHaveBeenCalled();
    expect(options.onDelete).toHaveBeenCalledTimes(2);
  });

  it("expands and opens Move with Cmd/Ctrl+S, including typing inside that row", () => {
    press("s", { metaKey: true });
    expect(options.onExpand).toHaveBeenCalledWith("a");
    expect(options.onMove).toHaveBeenCalledWith("a");
    press("s", { ctrlKey: true, target: new Target(true, "a") });
    expect(options.onMove).toHaveBeenCalledTimes(2);
  });

  it("ignores schedule repeats, modifiers, multi-selection and typing elsewhere", () => {
    for (const patch of [
      { repeat: true },
      { shiftKey: true },
      { altKey: true },
      { ctrlKey: true },
      { target: new Target(true, "b") },
    ]) {
      expect(press("s", { metaKey: true, ...patch }).preventDefault).not.toHaveBeenCalled();
    }
    options = { ...options, selectedIds: ["a", "b"] };
    act(() => renderer.update(<Probe />));
    press("s", { metaKey: true });
    expect(options.onMove).not.toHaveBeenCalled();
  });

  it("uses the hovered task when no task is selected", () => {
    options = { ...options, selectedIds: [], hoveredId: "b" };
    act(() => renderer.update(<Probe />));
    press("s", { metaKey: true });
    expect(options.onMove).toHaveBeenCalledWith("b");
  });

  it("captures Cmd/Ctrl+N for new tasks and ignores typing or extra modifiers", () => {
    expect(press("n", { metaKey: true }).stopImmediatePropagation).toHaveBeenCalledOnce();
    press("n", { ctrlKey: true });
    expect(options.onNew).toHaveBeenCalledTimes(2);
    expect(
      press("n", { metaKey: true, target: new Target(true) }).stopImmediatePropagation,
    ).toHaveBeenCalledOnce();
    press("n", { metaKey: true, shiftKey: true });
    press("n", { metaKey: true, altKey: true });
    expect(options.onNew).toHaveBeenCalledTimes(2);
  });

  it("leaves menus, editors and blocked shortcuts to their owners", () => {
    press("Escape", { target: new Target(false, null, true) });
    press("Escape", { target: new Target(true) });
    expect(options.onClear).not.toHaveBeenCalled();
    expect(
      press("Delete", { target: new Target(false, null, true) }).preventDefault,
    ).not.toHaveBeenCalled();
    expect(options.onDelete).not.toHaveBeenCalled();
    options = { ...options, isBlocked: () => true };
    act(() => renderer.update(<Probe />));
    press("n", { metaKey: true });
    expect(options.onNew).not.toHaveBeenCalled();
  });
});
