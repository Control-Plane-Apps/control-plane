import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";
import type { Task } from "@t3tools/contracts";

// Fork-owned. The ordering arithmetic behind dragging tasks on desktop:
// where a dropped row lands, which order keys to write, and the optimistic
// order a list shows while those writes are in flight.

/**
 * The list order after dropping `activeId` on `overId`, with arrayMove's
 * semantics (the same Lucive desktop uses, PlanTaskList.tsx handleDragEnd):
 * moving down lands after the row dropped on, moving up lands before it.
 * Null when the drop changes nothing.
 */
export function moveTaskId(
  ids: ReadonlyArray<string>,
  activeId: string,
  overId: string,
): string[] | null {
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return next;
}

/** The new order and the order keys to write for one dropped row. */
export function planTaskDrop(
  tasks: ReadonlyArray<Pick<Task, "id" | "orderKey">>,
  activeId: string,
  overId: string,
): {
  readonly orderedIds: ReadonlyArray<string>;
  readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
} | null {
  const orderedIds = moveTaskId(
    tasks.map((task) => task.id as string),
    activeId,
    overId,
  );
  if (orderedIds === null) return null;
  return {
    orderedIds,
    assignments: planPinnedReorder({
      orderedIds,
      movedId: activeId,
      keysById: new Map(tasks.map((task) => [task.id as string, task.orderKey ?? null])),
    }),
  };
}

/**
 * A dragged order the list shows before the server agrees: `saving` while
 * the order-key writes are in flight, `saved` once they all landed and the
 * list is waiting for the server's order to catch up.
 */
export interface TaskOrderOverride {
  readonly ids: ReadonlyArray<string>;
  readonly status: "saving" | "saved";
}

/**
 * The rows in the override's order. Rows the override does not know (added
 * mid-drag) keep their server position at the end; ids no longer present drop.
 */
export function applyTaskOrder<T extends { readonly id: string }>(
  tasks: ReadonlyArray<T>,
  override: TaskOrderOverride | null,
): ReadonlyArray<T> {
  if (override === null) return tasks;
  const byId = new Map(tasks.map((task) => [task.id as string, task]));
  const ordered: T[] = [];
  for (const id of override.ids) {
    const task = byId.get(id);
    if (task === undefined) continue;
    ordered.push(task);
    byId.delete(id);
  }
  for (const task of tasks) if (byId.has(task.id)) ordered.push(task);
  return ordered;
}

function sameIds(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * What happens to the override when its writes finish: any failure rolls the
 * list back to the server's order (the failed write already toasted); all
 * accepted keeps the dragged order until the server catches up. A newer drag
 * that replaced this one wins.
 */
export function overrideAfterWrites(
  current: TaskOrderOverride | null,
  written: TaskOrderOverride,
  results: ReadonlyArray<boolean>,
): TaskOrderOverride | null {
  if (current !== written) return current;
  if (results.some((ok) => !ok)) return null;
  return { ids: written.ids, status: "saved" };
}

/**
 * Drops a saved override once the server's order matches it, or once the set
 * of rows changed underneath it (the server's order is the truth again).
 */
export function settleTaskOrderOverride(
  override: TaskOrderOverride | null,
  serverIds: ReadonlyArray<string>,
): TaskOrderOverride | null {
  if (override === null || override.status !== "saved") return override;
  if (sameIds(override.ids, serverIds)) return null;
  const known = new Set(override.ids);
  if (serverIds.length !== known.size || serverIds.some((id) => !known.has(id))) return null;
  return override;
}
