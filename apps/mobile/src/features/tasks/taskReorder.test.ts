import { describe, expect, it } from "vite-plus/test";

import {
  autoScrollDelta,
  dayDropTarget,
  moveItem,
  planTaskReorder,
  reorderShift,
  reorderTargetIndex,
  type DropFrame,
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

describe("dayDropTarget", () => {
  const days = new Map<string, DropFrame>([
    ["2026-11-18", { x: 0, y: 100, width: 400, height: 120 }],
    ["2026-11-19", { x: 0, y: 230, width: 400, height: 160 }],
    ["2026-11-20", { x: 0, y: 400, width: 400, height: 60 }],
  ]);
  const gym = { status: "todo", home: { kind: "date", date: "2026-11-18" } } as const;

  it("finds the other day's card under the finger", () => {
    expect(dayDropTarget(days, 200, 300, gym)).toBe("2026-11-19");
    expect(dayDropTarget(days, 200, 420, gym)).toBe("2026-11-20");
  });

  it("never targets the task's own day, so dragging inside it reorders", () => {
    expect(dayDropTarget(days, 200, 150, gym)).toBeNull();
  });

  it("finds nothing in the gaps between cards or outside them", () => {
    expect(dayDropTarget(days, 200, 225, gym)).toBeNull();
    expect(dayDropTarget(days, 500, 300, gym)).toBeNull();
  });

  it("lets a committed or backlog task drop on any day, but not a closed one", () => {
    const committed = {
      status: "todo",
      home: { kind: "period", horizon: "week", startsOn: "2026-11-16", endsOn: "2026-11-22" },
    } as const;
    expect(dayDropTarget(days, 200, 150, committed)).toBe("2026-11-18");
    expect(dayDropTarget(days, 200, 300, { ...gym, status: "completed" })).toBeNull();
  });
});

describe("autoScrollDelta", () => {
  // A page whose visible area is y 100 to 800, scrolled 200 into 2000 of content.
  const page = { top: 100, viewport: 700, offset: 200, content: 2000 };

  it("does nothing in the middle of the page", () => {
    expect(autoScrollDelta({ ...page, y: 450 })).toBe(0);
  });

  it("scrolls up near the top edge and down near the bottom, faster closer in", () => {
    const nearTop = autoScrollDelta({ ...page, y: 150 });
    const atTop = autoScrollDelta({ ...page, y: 100 });
    expect(nearTop).toBeLessThan(0);
    expect(atTop).toBeLessThan(nearTop);
    const nearBottom = autoScrollDelta({ ...page, y: 750 });
    const atBottom = autoScrollDelta({ ...page, y: 800 });
    expect(nearBottom).toBeGreaterThan(0);
    expect(atBottom).toBeGreaterThan(nearBottom);
  });

  it("stops at the ends of the content", () => {
    expect(autoScrollDelta({ ...page, offset: 0, y: 100 })).toBe(0);
    expect(autoScrollDelta({ ...page, offset: 1300, y: 800 })).toBe(0);
    expect(autoScrollDelta({ ...page, offset: 1295, y: 800 })).toBe(5);
    expect(autoScrollDelta({ ...page, offset: 5, y: 100 })).toBe(-5);
  });

  it("does not scroll a page that fits", () => {
    expect(autoScrollDelta({ top: 100, viewport: 700, offset: 0, content: 500, y: 790 })).toBe(0);
  });
});
