import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";
import type { Task } from "@t3tools/contracts";

// Fork-owned. The arithmetic behind long-press drag reordering in the task
// lists. Rows report their frames; the lifted row's centre picks the slot.

export interface ReorderFrame {
  readonly y: number;
  readonly height: number;
}

/** Where the lifted row lands: the slot whose midpoint its centre has crossed. */
export function reorderTargetIndex(
  frames: ReadonlyArray<ReorderFrame | undefined>,
  from: number,
  translation: number,
): number {
  const source = frames[from];
  if (source === undefined) return from;
  const centre = source.y + source.height / 2 + translation;
  let to = from;
  for (let index = from + 1; index < frames.length; index++) {
    const frame = frames[index];
    if (frame === undefined || centre <= frame.y + frame.height / 2) break;
    to = index;
  }
  if (to !== from) return to;
  for (let index = from - 1; index >= 0; index--) {
    const frame = frames[index];
    if (frame === undefined || centre >= frame.y + frame.height / 2) break;
    to = index;
  }
  return to;
}

/** How far a resting row slides to open the gap for the lifted one. */
export function reorderShift(index: number, from: number, to: number, height: number): number {
  if (index === from) return 0;
  if (from < to && index > from && index <= to) return -height;
  if (to < from && index >= to && index < from) return height;
  return 0;
}

export function moveItem<T>(items: ReadonlyArray<T>, from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

/** The order keys to write, the same way desktop's task list does on drop. */
export function planTaskReorder(
  tasks: ReadonlyArray<Pick<Task, "id" | "orderKey">>,
  from: number,
  to: number,
): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> {
  const moved = tasks[from];
  if (moved === undefined || from === to) return [];
  return planPinnedReorder({
    orderedIds: moveItem(
      tasks.map((task) => task.id as string),
      from,
      to,
    ),
    movedId: moved.id,
    keysById: new Map(tasks.map((task) => [task.id as string, task.orderKey ?? null])),
  });
}

export interface DropFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The day card (by date) under the finger while a task is lifted, in window
 * coordinates. The task's own day is never a target, so dragging inside it
 * still reorders; a task that is not open has none.
 */
export function dayDropTarget(
  frames: ReadonlyMap<string, DropFrame>,
  x: number,
  y: number,
  lifted: Pick<Task, "home" | "status">,
): string | null {
  if (lifted.status !== "todo") return null;
  for (const [date, frame] of frames) {
    if (lifted.home.kind === "date" && lifted.home.date === date) continue;
    if (x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height) {
      return date;
    }
  }
  return null;
}
