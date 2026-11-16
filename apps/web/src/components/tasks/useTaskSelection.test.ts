import { describe, expect, it } from "vite-plus/test";
import { emptyTaskSelection, pruneTaskSelection, selectTask } from "./useTaskSelection";

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
