import { act, createElement, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  emptyTaskSelection,
  pruneTaskSelection,
  selectTask,
  useTaskSelection,
} from "./useTaskSelection";

const ids = ["a", "b", "c", "d"];
const click = { shiftKey: false, metaKey: false };

describe("task selection", () => {
  it("replaces selection on plain click and toggles with Cmd or Ctrl", () => {
    let state = selectTask(emptyTaskSelection(), ids, "a", click);
    state = selectTask(state, ids, "c", { ...click, metaKey: true });
    expect([...state.selected]).toEqual(["a", "c"]);
    state = selectTask(state, ids, "a", { ...click, ctrlKey: true });
    expect([...state.selected]).toEqual(["c"]);
    state = selectTask(state, ids, "b", click);
    expect([...state.selected]).toEqual(["b"]);
  });

  it("expands and shrinks ranges from the anchor's base selection", () => {
    let state = selectTask(emptyTaskSelection(), ids, "a", click);
    state = selectTask(state, ids, "b", { ...click, metaKey: true });
    state = selectTask(state, ids, "d", { ...click, shiftKey: true });
    expect([...state.selected]).toEqual(ids);
    state = selectTask(state, ids, "c", { ...click, shiftKey: true });
    expect([...state.selected]).toEqual(["a", "b", "c"]);
    state = selectTask(state, ids, "a", { ...click, shiftKey: true });
    expect([...state.selected]).toEqual(["a", "b"]);
  });

  it("prunes hidden or deleted tasks and the anchor", () => {
    let state = selectTask(emptyTaskSelection(), ids, "b", click);
    state = selectTask(state, ids, "d", { ...click, metaKey: true });
    state = pruneTaskSelection(state, ["a", "b"]);
    expect([...state.selected]).toEqual(["b"]);
    expect([...state.base]).toEqual(["b"]);
    expect(state.anchor).toBeNull();
    expect(pruneTaskSelection(state, ["a", "b"])).toBe(state);
    expect(emptyTaskSelection().selected.size).toBe(0);
  });
});

describe("outside clicks", () => {
  let renderer: ReactTestRenderer | undefined;
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("clears selection and its range anchor outside rows, preserving row and action clicks", async () => {
    const listeners = new Set<(event: { target: Target }) => void>();
    class Target {
      constructor(
        readonly rowId: string | null = null,
        readonly actions = false,
      ) {}
      closest(selector: string) {
        return selector === "[data-task-id]"
          ? this.rowId === null
            ? null
            : this
          : this.actions
            ? this
            : null;
      }
      getAttribute() {
        return this.rowId;
      }
    }
    vi.stubGlobal("Element", Target);
    vi.stubGlobal("document", {
      addEventListener: (_key: string, listener: (event: { target: Target }) => void) =>
        listeners.add(listener),
      removeEventListener: (_key: string, listener: (event: { target: Target }) => void) =>
        listeners.delete(listener),
    });
    let selection!: ReturnType<typeof useTaskSelection>;
    function Harness() {
      const current = useTaskSelection(ids);
      useEffect(() => {
        selection = current;
      });
      return null;
    }
    await act(async () => {
      renderer = create(createElement(Harness));
    });
    await act(async () => selection.handleRowClick("b", click));
    const dispatch = async (target: Target) => {
      await act(async () => {
        for (const listener of listeners) listener({ target });
      });
    };
    await dispatch(new Target("b"));
    await dispatch(new Target(null, true));
    expect([...selection.selectedIds]).toEqual(["b"]);
    await dispatch(new Target());
    expect(selection.selectedCount).toBe(0);
    expect(listeners.size).toBe(0);
    await act(async () => selection.handleRowClick("d", { ...click, shiftKey: true }));
    expect([...selection.selectedIds]).toEqual(["d"]);
    await dispatch(new Target("unrelated-list-task"));
    expect(selection.selectedCount).toBe(0);
  });
});
