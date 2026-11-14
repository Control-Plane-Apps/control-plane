import { describe, expect, it } from "vite-plus/test";

import {
  moveItem,
  planTaskReorder,
  reorderShift,
  reorderTargetIndex,
  type ReorderFrame,
} from "./taskReorder";

// Four 50pt rows stacked from y=0.
const frames: ReorderFrame[] = [0, 50, 100, 150].map((y) => ({ y, height: 50 }));

describe("reorderTargetIndex", () => {
  it("stays put until the centre crosses a neighbour's midpoint", () => {
    expect(reorderTargetIndex(frames, 1, 0)).toBe(1);
    expect(reorderTargetIndex(frames, 1, 49)).toBe(1);
    expect(reorderTargetIndex(frames, 1, 51)).toBe(2);
    expect(reorderTargetIndex(frames, 1, -49)).toBe(1);
    expect(reorderTargetIndex(frames, 1, -51)).toBe(0);
  });

  it("clamps to the ends of the list", () => {
    expect(reorderTargetIndex(frames, 0, 1000)).toBe(3);
    expect(reorderTargetIndex(frames, 3, -1000)).toBe(0);
  });

  it("ignores rows that have not reported a frame", () => {
    expect(reorderTargetIndex([frames[0], undefined, frames[2]], 0, 200)).toBe(0);
    expect(reorderTargetIndex([undefined], 0, 200)).toBe(0);
  });
});

describe("reorderShift", () => {
  it("slides rows between the slots to open the gap", () => {
    expect([0, 1, 2, 3].map((i) => reorderShift(i, 0, 2, 50))).toEqual([0, -50, -50, 0]);
    expect([0, 1, 2, 3].map((i) => reorderShift(i, 3, 1, 50))).toEqual([0, 50, 50, 0]);
    expect([0, 1, 2, 3].map((i) => reorderShift(i, 2, 2, 50))).toEqual([0, 0, 0, 0]);
  });
});

describe("moveItem", () => {
  it("moves one item and keeps the rest in order", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
  });
});

describe("planTaskReorder", () => {
  it("keys unordered tasks so the new order sticks", () => {
    const plain = [{ id: "a" }, { id: "b" }, { id: "c" }] as never;
    const plan = planTaskReorder(plain, 2, 0);
    const keys = new Map(plan.map((entry) => [entry.id, entry.orderKey]));
    const order = ["c", "a", "b"].map((id) => keys.get(id));
    expect(order.every((key) => key !== undefined)).toBe(true);
    expect([...order].sort()).toEqual(order);
  });

  it("then writes only the moved task, between its new neighbours", () => {
    expect(planTaskReorder([{ id: "a" }, { id: "b" }] as never, 1, 1)).toEqual([]);
    const first = planTaskReorder(
      [{ id: "x" }, { id: "a" }, { id: "b" }, { id: "c" }] as never,
      0,
      3,
    );
    const keys = new Map(first.map((entry) => [entry.id, entry.orderKey]));
    const tasks = ["a", "b", "c"].map((id) => ({ id, orderKey: keys.get(id) })) as never;
    const plan = planTaskReorder(tasks, 0, 2);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.id).toBe("a");
    expect(plan[0]!.orderKey > keys.get("c")!).toBe(true);
  });
});
