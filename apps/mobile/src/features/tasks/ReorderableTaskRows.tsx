import type { Task } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, {
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { moveItem, type ReorderFrame, reorderShift, reorderTargetIndex } from "./taskReorder";

// Fork-owned. Long-press a task, then drag it up or down to reorder the list.
// The pan only activates after the hold and fails if the finger moves first,
// so a quick vertical move still scrolls and a horizontal one still reaches
// the row's swipe actions (select, Move, Schedule).

const LONG_PRESS_MS = 300;

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
}) {
  const frames = useRef<Array<ReorderFrame | undefined>>([]);
  const translation = useSharedValue(0);
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

  const start = (index: number) => {
    translation.value = 0;
    const next = { from: index, to: index, height: frames.current[index]?.height ?? 0 };
    latest.current.drag = next;
    setDrag(next);
    latest.current.props.onDragActiveChange?.(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
  };
  const move = (dy: number) => {
    const current = latest.current.drag;
    if (current === null) return;
    translation.value = dy;
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
    latest.current.props.onDragActiveChange?.(false);
    if (!commit || current.from === current.to) return;
    const list = latest.current.tasks;
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
      enabled={props.enabled && tasks.length > 1}
      lifted={drag?.from === index}
      dragging={drag !== null}
      shift={drag === null ? 0 : reorderShift(index, drag.from, drag.to, drag.height)}
      translation={translation}
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
  readonly onLayout: (frame: ReorderFrame) => void;
  readonly handlers: {
    readonly current: {
      readonly start: (index: number) => void;
      readonly move: (dy: number) => void;
      readonly end: (commit: boolean) => void;
    };
  };
  readonly children: ReactNode;
}) {
  const { index, handlers, lifted, dragging, shift, translation } = props;
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(props.enabled)
        .activateAfterLongPress(LONG_PRESS_MS)
        .shouldCancelWhenOutside(false)
        .runOnJS(true)
        .onStart(() => handlers.current.start(index))
        .onUpdate((event) => handlers.current.move(event.translationY))
        .onEnd((_, success) => handlers.current.end(success))
        .onFinalize((_, success) => {
          if (!success) handlers.current.end(false);
        }),
    [handlers, index, props.enabled],
  );
  const style = useAnimatedStyle(() => ({
    zIndex: lifted ? 10 : 0,
    shadowOpacity: lifted ? 0.18 : 0,
    transform: [
      {
        translateY: lifted
          ? translation.value
          : dragging
            ? withTiming(shift, { duration: 160, reduceMotion: ReduceMotion.System })
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
