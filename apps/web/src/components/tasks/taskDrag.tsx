import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type DropAnimation,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { Task } from "@t3tools/contracts";
import { useState, useSyncExternalStore, type ReactNode } from "react";

// Fork-owned. Desktop task dragging, matching Lucive desktop
// (lucive/src/components/planning/PlanTaskList.tsx, PlanTaskRow.tsx):
//
// - Library: @dnd-kit/core 6.3.1 + @dnd-kit/sortable 10.0.0, the versions
//   Lucive pins (lucive/package.json:43-44) and this app already depends on.
// - PointerSensor with activationConstraint { distance: 5 } plus
//   KeyboardSensor with sortableKeyboardCoordinates (PlanTaskList.tsx:91-94).
// - closestCenter collisions, verticalListSortingStrategy (PlanTaskList.tsx:223-226).
// - Rows animate aside with useSortable's default transition, 250ms ease
//   (Lucive passes `transition` straight through, PlanTaskRow.tsx:312-317).
// - The dragged row sits at opacity 0.5, z-index 10 (PlanTaskRow.tsx:315-316).
// - Auto-scroll is dnd-kit's default (Lucive does not configure it).
// - The grip is the only activator, visible on row hover (planning.css:535-549).
//
// Two deliberate additions: a DragOverlay (same 250ms ease drop animation as
// dnd-kit's default) so the row can travel over the page header and sidebar
// without the scroll area clipping it, and the keyboard listeners sit on the
// grip button itself so the keyboard sensor is actually reachable.

export const TASK_DRAG_ACTIVATION_DISTANCE_PX = 5;
export const TASK_DRAG_TRANSITION = { duration: 250, easing: "ease" } as const;
const TASK_DROP_ANIMATION: DropAnimation = { duration: 250, easing: "ease" };

/** The kind of droppable a range tab registers. */
export const TASK_RANGE_DROP = "task-range";
/** Marks the sidebar Tasks row, which lives outside the Tasks page's DndContext. */
export const TASK_SIDEBAR_DROP_ATTR = "data-task-drop-today";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  if (typeof window === "undefined" || window.matchMedia === undefined) return () => {};
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () =>
      typeof window !== "undefined" &&
      window.matchMedia !== undefined &&
      window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}

// The sidebar Tasks row is in another subtree, so it cannot register a
// dnd-kit droppable here. The page hit-tests it under the pointer and
// publishes whether a task hovers it; the row reads that for its outline.
let sidebarHover = false;
const sidebarListeners = new Set<() => void>();

function setSidebarHover(next: boolean) {
  if (sidebarHover === next) return;
  sidebarHover = next;
  for (const listener of sidebarListeners) listener();
}

export function useTaskSidebarDropHover(): boolean {
  return useSyncExternalStore(
    (listener) => {
      sidebarListeners.add(listener);
      return () => sidebarListeners.delete(listener);
    },
    () => sidebarHover,
    () => false,
  );
}

function sortableContainerOf(data: unknown): string | null {
  const sortable = (data as { sortable?: { containerId?: unknown } } | undefined)?.sortable;
  return typeof sortable?.containerId === "string" ? sortable.containerId : null;
}

function isRangeDrop(data: unknown): boolean {
  return (data as { type?: unknown } | undefined)?.type === TASK_RANGE_DROP;
}

/**
 * Range tabs win when the pointer is on one; otherwise closestCenter among the
 * rows of the dragged row's own list (lists do not trade rows), and nothing at
 * all for a list whose order is not the user's.
 */
const taskCollisions: CollisionDetection = (args) => {
  const tabs = args.droppableContainers.filter((entry) => isRangeDrop(entry.data.current));
  const onTab = pointerWithin({ ...args, droppableContainers: tabs });
  if (onTab.length > 0) return onTab;
  const activeData = args.active.data.current as { reorderable?: boolean } | undefined;
  if (activeData?.reorderable !== true) return [];
  const container = sortableContainerOf(activeData);
  const rows = args.droppableContainers.filter(
    (entry) => sortableContainerOf(entry.data.current) === container,
  );
  return closestCenter({ ...args, droppableContainers: rows });
};

/** sortableKeyboardCoordinates, limited to the dragged row's own list. */
const taskKeyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  const { context } = args;
  const container = sortableContainerOf(context.active?.data.current);
  const all = context.droppableContainers;
  const scoped = {
    get: (id: Parameters<typeof all.get>[0]) => all.get(id),
    getEnabled: () =>
      all.getEnabled().filter((entry) => sortableContainerOf(entry.data.current) === container),
  } as typeof all;
  return sortableKeyboardCoordinates(event, {
    ...args,
    context: { ...context, droppableContainers: scoped },
  });
};

function pointerOf(event: DragMoveEvent | DragEndEvent): { x: number; y: number } | null {
  const start = event.activatorEvent;
  if (!(start instanceof PointerEvent) && !(start instanceof MouseEvent)) return null;
  return { x: start.clientX + event.delta.x, y: start.clientY + event.delta.y };
}

function overSidebarTasks(point: { x: number; y: number } | null): boolean {
  if (point === null || typeof document === "undefined") return false;
  return document
    .elementsFromPoint(point.x, point.y)
    .some((element) => element.closest(`[${TASK_SIDEBAR_DROP_ATTR}]`) !== null);
}

/**
 * One drag context for the whole Tasks page: every list's sortable rows and
 * the range tabs. Lists handle their own reorders (useDndMonitor); this
 * handles drops on a range tab or the sidebar Tasks row.
 */
export function TaskDragProvider(props: {
  readonly tasks: ReadonlyArray<Task>;
  readonly onDropOnRange: (task: Task, view: string) => void;
  readonly onDropOnSidebar: (task: Task) => void;
  readonly renderOverlay: (task: Task) => ReactNode;
  readonly children: ReactNode;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: TASK_DRAG_ACTIVATION_DISTANCE_PX },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: taskKeyboardCoordinates }),
  );
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [droppedAway, setDroppedAway] = useState(false);

  const finish = () => {
    setActiveTask(null);
    setSidebarHover(false);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={taskCollisions}
      onDragStart={(event: DragStartEvent) => {
        setDroppedAway(false);
        setActiveTask(props.tasks.find((task) => task.id === event.active.id) ?? null);
      }}
      onDragMove={(event) => setSidebarHover(overSidebarTasks(pointerOf(event)))}
      onDragCancel={finish}
      onDragEnd={(event) => {
        const task = props.tasks.find((candidate) => candidate.id === event.active.id);
        const onSidebar = overSidebarTasks(pointerOf(event));
        const overData = event.over?.data.current as { type?: unknown; view?: unknown } | undefined;
        finish();
        if (task === undefined) return;
        if (onSidebar) {
          setDroppedAway(true);
          props.onDropOnSidebar(task);
        } else if (isRangeDrop(overData) && typeof overData?.view === "string") {
          setDroppedAway(true);
          props.onDropOnRange(task, overData.view);
        }
      }}
    >
      {props.children}
      <DragOverlay dropAnimation={reducedMotion || droppedAway ? null : TASK_DROP_ANIMATION}>
        {activeTask !== null ? props.renderOverlay(activeTask) : null}
      </DragOverlay>
    </DndContext>
  );
}
