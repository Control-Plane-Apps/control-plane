import type { Task } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, {
  ReduceMotion,
  runOnJS,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

import { moveItem, type ReorderFrame, reorderShift, reorderTargetIndex } from "./taskReorder";

// Fork-owned. Long-press a task, then drag it up or down to reorder the list.
// The pan only activates after the hold and fails if the finger moves first,
// so a quick vertical move still scrolls and a horizontal one still reaches
// the row's swipe actions (select, Move, Schedule). With `dropTargets`, the
// lifted row can also be dragged onto a range chip to move its home.

const LONG_PRESS_MS = 300;

/** Places outside the list a lifted row can be dropped on, in window coordinates. */
export interface TaskDropTargets {
  /** The target under the finger, for the lifted task (its own day is never one). */
  readonly hitTest: (x: number, y: number, task: Task) => string | null;
  readonly onHover: (target: string | null) => void;
  readonly onDrop: (task: Task, target: string) => void;
}

interface Drag {
  readonly from: number;
  readonly to: number;
  /** The lifted row's height: the gap the others open for it. */
  readonly height: number;
}

export function ReorderableTaskRows(props: {
  readonly tasks: ReadonlyArray<Task>;
  readonly enabled: boolean;
  readonly renderRow: (task: Task, index: number) => ReactNode;
  /** The drop, in the list's own indices. */
  readonly onReorder: (tasks: ReadonlyArray<Task>, from: number, to: number) => void;
  readonly onDragActiveChange?: (active: boolean) => void;
  readonly dropTargets?: TaskDropTargets;
}) {
  const frames = useRef<Array<ReorderFrame | undefined>>([]);
  const translation = useSharedValue(0);
  const translationX = useSharedValue(0);
  const hovered = useRef<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Hold the dropped order until the store's own order catches up, so rows
  // don't flash back to their old slots while the write is in flight.
  const [pending, setPending] = useState<{ readonly base: string; readonly ids: string[] } | null>(
    null,
  );
  const baseKey = props.tasks.map((task) => task.id).join("\n");
  const pendingOrder = pending !== null && pending.base === baseKey ? pending.ids : null;
  const tasks = useMemo(() => {
    if (pendingOrder === null) return props.tasks;
    const byId = new Map(props.tasks.map((task) => [task.id as string, task]));
    return pendingOrder.flatMap((id) => {
      const task = byId.get(id);
      return task ? [task] : [];
    });
  }, [pendingOrder, props.tasks]);

  const latest = useRef({ props, tasks, drag });
  latest.current = { props, tasks, drag };

  const setHovered = (target: string | null) => {
    if (hovered.current === target) return;
    hovered.current = target;
    latest.current.props.dropTargets?.onHover(target);
    if (target !== null) void Haptics.selectionAsync().catch(() => undefined);
  };
  const start = (index: number) => {
    translation.value = 0;
    translationX.value = 0;
    hovered.current = null;
    const next = { from: index, to: index, height: frames.current[index]?.height ?? 0 };
    latest.current.drag = next;
    setDrag(next);
    latest.current.props.onDragActiveChange?.(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
  };
  const move = (dy: number, dx: number, x: number, y: number) => {
    const current = latest.current.drag;
    if (current === null) return;
    translation.value = dy;
    const lifted = latest.current.tasks[current.from];
    const target =
      lifted === undefined
        ? null
        : (latest.current.props.dropTargets?.hitTest(x, y, lifted) ?? null);
    setHovered(target);
    // Follow the finger sideways only while it is over a drop target.
    translationX.value = target === null ? 0 : dx;
    if (target !== null) return;
    const to = reorderTargetIndex(frames.current, current.from, dy);
    if (to === current.to) return;
    const next = { ...current, to };
    latest.current.drag = next;
    setDrag(next);
    void Haptics.selectionAsync().catch(() => undefined);
  };
  const end = (commit: boolean) => {
    const current = latest.current.drag;
    // Taps and swipes finalize a pan that never lifted anything.
    if (current === null) return;
    latest.current.drag = null;
    setDrag(null);
    translation.value = 0;
    translationX.value = 0;
    const target = hovered.current;
    setHovered(null);
    latest.current.props.onDragActiveChange?.(false);
    const list = latest.current.tasks;
    const lifted = list[current.from];
    if (commit && target !== null && lifted !== undefined) {
      latest.current.props.dropTargets?.onDrop(lifted, target);
      return;
    }
    if (!commit || current.from === current.to) return;
    setPending({
      base: latest.current.props.tasks.map((task) => task.id).join("\n"),
      ids: moveItem(
        list.map((task) => task.id as string),
        current.from,
        current.to,
      ),
    });
    latest.current.props.onReorder(list, current.from, current.to);
  };
  const handlers = useRef({ start, move, end });
  handlers.current = { start, move, end };

  return tasks.map((task, index) => (
    <ReorderItem
      key={task.id}
      index={index}
      enabled={props.enabled && (tasks.length > 1 || props.dropTargets !== undefined)}
      lifted={drag?.from === index}
      dragging={drag !== null}
      shift={drag === null ? 0 : reorderShift(index, drag.from, drag.to, drag.height)}
      translation={translation}
      translationX={translationX}
      onLayout={(frame) => {
        frames.current[index] = frame;
        frames.current.length = tasks.length;
      }}
      handlers={handlers}
    >
      {props.renderRow(task, index)}
    </ReorderItem>
  ));
}

function ReorderItem(props: {
  readonly index: number;
  readonly enabled: boolean;
  readonly lifted: boolean;
  readonly dragging: boolean;
  readonly shift: number;
  readonly translation: SharedValue<number>;
  readonly translationX: SharedValue<number>;
  readonly onLayout: (frame: ReorderFrame) => void;
  readonly handlers: {
    readonly current: {
      readonly start: (index: number) => void;
      readonly move: (dy: number, dx: number, x: number, y: number) => void;
      readonly end: (commit: boolean) => void;
    };
  };
  readonly children: ReactNode;
}) {
  const { index, handlers, lifted, dragging, shift, translation, translationX } = props;
  const gesture = useMemo(() => {
    // The lifted row follows the finger on the UI thread, so the drag stays
    // smooth while the JS side works out the slot and any range under it.
    const start = () => handlers.current.start(index);
    const move = (dy: number, dx: number, x: number, y: number) =>
      handlers.current.move(dy, dx, x, y);
    const end = (commit: boolean) => handlers.current.end(commit);
    return Gesture.Pan()
      .enabled(props.enabled)
      .activateAfterLongPress(LONG_PRESS_MS)
      .shouldCancelWhenOutside(false)
      .onStart(() => {
        runOnJS(start)();
      })
      .onUpdate((event) => {
        translation.value = event.translationY;
        runOnJS(move)(event.translationY, event.translationX, event.absoluteX, event.absoluteY);
      })
      .onEnd((_, success) => {
        runOnJS(end)(success);
      })
      .onFinalize((_, success) => {
        if (!success) runOnJS(end)(false);
      });
  }, [handlers, index, props.enabled, translation]);
  const style = useAnimatedStyle(() => ({
    zIndex: lifted ? 10 : 0,
    shadowOpacity: lifted ? 0.18 : 0,
    transform: [
      { translateX: lifted ? translationX.value : 0 },
      {
        translateY: lifted
          ? translation.value
          : dragging
            ? withSpring(shift, {
                damping: 26,
                stiffness: 320,
                mass: 0.8,
                reduceMotion: ReduceMotion.System,
              })
            : 0,
      },
      { scale: lifted ? 1.02 : 1 },
    ],
  }));
  return (
    <GestureDetector gesture={gesture}>
      <Reanimated.View
        collapsable={false}
        onLayout={(event) =>
          props.onLayout({
            y: event.nativeEvent.layout.y,
            height: event.nativeEvent.layout.height,
          })
        }
        style={[
          { shadowColor: "#000", shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
          style,
        ]}
      >
        {props.children}
      </Reanimated.View>
    </GestureDetector>
  );
}
