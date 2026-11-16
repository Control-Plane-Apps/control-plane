import { describe, expect, it } from "vite-plus/test";

import {
  applyTaskOrder,
  moveTaskId,
  overrideAfterWrites,
  planTaskDrop,
  settleTaskOrderOverride,
  type TaskOrderOverride,
} from "./taskDrag.logic";

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

describe("moveTaskId", () => {
  it("lands after the row dropped on when moving down", () => {
    expect(moveTaskId(["a", "b", "c", "d"], "a", "c")).toEqual(["b", "c", "a", "d"]);
  });

  it("lands before the row dropped on when moving up", () => {
    expect(moveTaskId(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  it("is a no-op on itself or an unknown row", () => {
    expect(moveTaskId(["a", "b"], "a", "a")).toBeNull();
    expect(moveTaskId(["a", "b"], "a", "z")).toBeNull();
  });
});

describe("planTaskDrop", () => {
  it("returns the new order and keys that sort in it", () => {
    const plan = planTaskDrop(
      [
        { id: "a", orderKey: "a0" },
        { id: "b", orderKey: "a1" },
        { id: "c", orderKey: "a2" },
      ] as never,
      "c",
      "a",
    );
    expect(plan?.orderedIds).toEqual(["c", "a", "b"]);
    const keys = new Map([
      ["a", "a0"],
      ["b", "a1"],
      ["c", "a2"],
    ]);
    for (const assignment of plan?.assignments ?? []) keys.set(assignment.id, assignment.orderKey);
    const sorted = [...keys.entries()].toSorted((x, y) => (x[1] < y[1] ? -1 : 1)).map(([id]) => id);
    expect(sorted).toEqual(["c", "a", "b"]);
  });
});

describe("applyTaskOrder", () => {
  it("shows the server order without an override", () => {
    const tasks = rows("a", "b");
    expect(applyTaskOrder(tasks, null)).toBe(tasks);
  });

  it("shows the dragged order, keeping new rows at the end and dropping gone ones", () => {
    const override: TaskOrderOverride = { ids: ["c", "gone", "a", "b"], status: "saving" };
    expect(applyTaskOrder(rows("a", "b", "new", "c"), override).map((t) => t.id)).toEqual([
      "c",
      "a",
      "b",
      "new",
    ]);
  });
});

describe("overrideAfterWrites", () => {
  const written: TaskOrderOverride = { ids: ["b", "a"], status: "saving" };

  it("rolls back to the server order when any write fails", () => {
    expect(overrideAfterWrites(written, written, [true, false])).toBeNull();
  });

  it("keeps the dragged order once every write landed", () => {
    expect(overrideAfterWrites(written, written, [true, true])).toEqual({
      ids: ["b", "a"],
      status: "saved",
    });
  });

  it("leaves a newer drag alone", () => {
    const newer: TaskOrderOverride = { ids: ["a", "b"], status: "saving" };
    expect(overrideAfterWrites(newer, written, [false])).toBe(newer);
  });
});

describe("settleTaskOrderOverride", () => {
  it("keeps a saving override whatever the server says", () => {
    const saving: TaskOrderOverride = { ids: ["b", "a"], status: "saving" };
    expect(settleTaskOrderOverride(saving, ["a", "b"])).toBe(saving);
  });

  it("drops a saved override once the server order matches", () => {
    expect(settleTaskOrderOverride({ ids: ["b", "a"], status: "saved" }, ["b", "a"])).toBeNull();
  });

  it("waits for the server while it still shows the old order", () => {
    const saved: TaskOrderOverride = { ids: ["b", "a"], status: "saved" };
    expect(settleTaskOrderOverride(saved, ["a", "b"])).toBe(saved);
  });

  it("drops a saved override when the rows changed underneath it", () => {
    expect(
      settleTaskOrderOverride({ ids: ["b", "a"], status: "saved" }, ["a", "b", "c"]),
    ).toBeNull();
  });
});
