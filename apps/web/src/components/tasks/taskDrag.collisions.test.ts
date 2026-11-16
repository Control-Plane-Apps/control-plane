import type { CollisionDetection } from "@dnd-kit/core";
import { describe, expect, it } from "vite-plus/test";

import { TASK_DAY_DROP, TASK_RANGE_DROP, taskCollisions } from "./taskDrag";

type Args = Parameters<CollisionDetection>[0];
interface Box {
  readonly id: string;
  readonly data: Record<string, unknown>;
  readonly rect: { top: number; left: number; width: number; height: number };
}

function collide(input: {
  readonly active: Record<string, unknown>;
  readonly boxes: ReadonlyArray<Box>;
  readonly pointer: { x: number; y: number };
}): string[] {
  const rects = new Map(
    input.boxes.map((box) => [
      box.id,
      {
        ...box.rect,
        bottom: box.rect.top + box.rect.height,
        right: box.rect.left + box.rect.width,
      },
    ]),
  );
  const args = {
    active: { id: "dragged", data: { current: input.active } },
    collisionRect: { top: input.pointer.y, left: input.pointer.x, width: 1, height: 1 },
    droppableRects: rects,
    droppableContainers: input.boxes.map((box) => ({
      id: box.id,
      data: { current: box.data },
      disabled: false,
      node: { current: null },
      rect: { current: rects.get(box.id) },
      key: box.id,
    })),
    pointerCoordinates: input.pointer,
  } as unknown as Args;
  return taskCollisions(args).map((collision) => String(collision.id));
}

const day = (date: string, top: number): Box => ({
  id: `${TASK_DAY_DROP}:${date}`,
  data: { type: TASK_DAY_DROP, date },
  rect: { top, left: 0, width: 600, height: 100 },
});
const row = (id: string, container: string, top: number): Box => ({
  id,
  data: { sortable: { containerId: container } },
  rect: { top, left: 10, width: 580, height: 30 },
});
const tab: Box = {
  id: `${TASK_RANGE_DROP}:today`,
  data: { type: TASK_RANGE_DROP, view: "today" },
  rect: { top: 0, left: 0, width: 60, height: 20 },
};

describe("taskCollisions with day cards", () => {
  // Wed (homeDate 11-18) holds "gym"; Thu (11-19) holds two rows below it.
  const boxes = [
    day("2026-11-18", 100),
    day("2026-11-19", 220),
    row("gym", "wed", 130),
    row("washer", "thu", 250),
    row("dishwasher", "thu", 280),
  ];
  const active = { reorderable: true, homeDate: "2026-11-18", sortable: { containerId: "wed" } };

  it("drops on another day's card when the pointer is over it", () => {
    expect(collide({ active, boxes, pointer: { x: 300, y: 300 } })).toEqual([
      `${TASK_DAY_DROP}:2026-11-19`,
    ]);
  });

  it("lands on an empty day's card too", () => {
    const withEmpty = [...boxes, day("2026-11-20", 340)];
    expect(collide({ active, boxes: withEmpty, pointer: { x: 300, y: 390 } })).toEqual([
      `${TASK_DAY_DROP}:2026-11-20`,
    ]);
  });

  it("reorders inside its own day instead of treating it as a drop", () => {
    expect(collide({ active, boxes, pointer: { x: 300, y: 140 } })).toEqual(["gym"]);
  });

  it("prefers a range tab under the pointer", () => {
    expect(collide({ active, boxes: [tab, ...boxes], pointer: { x: 30, y: 10 } })).toEqual([
      `${TASK_RANGE_DROP}:today`,
    ]);
  });

  it("finds no day when the pointer is between cards", () => {
    const hits = collide({ active, boxes, pointer: { x: 300, y: 212 } });
    expect(hits.some((id) => id.startsWith(TASK_DAY_DROP))).toBe(false);
  });

  it("lets a task that cannot reorder still drop on another day", () => {
    const fixed = { reorderable: false, homeDate: "2026-11-18", sortable: { containerId: "wed" } };
    expect(collide({ active: fixed, boxes, pointer: { x: 300, y: 300 } })).toEqual([
      `${TASK_DAY_DROP}:2026-11-19`,
    ]);
    expect(collide({ active: fixed, boxes, pointer: { x: 300, y: 140 } })).toEqual([]);
  });
});
