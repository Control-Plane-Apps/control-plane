import { useCallback, useState } from "react";

export interface TaskSelectionClickEvent {
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey?: boolean;
}

export interface TaskSelectionState {
  readonly selected: ReadonlySet<string>;
  readonly base: ReadonlySet<string>;
  readonly anchor: string | null;
}

export function emptyTaskSelection(): TaskSelectionState {
  return { selected: new Set(), base: new Set(), anchor: null };
}

/** Range clicks always start at the last plain/modifier click, so ranges can shrink. */
export function selectTask(
  state: TaskSelectionState,
  orderedIds: readonly string[],
  id: string,
  event: TaskSelectionClickEvent,
): TaskSelectionState {
  if (event.shiftKey && state.anchor !== null) {
    const anchor = orderedIds.indexOf(state.anchor);
    const target = orderedIds.indexOf(id);
    if (anchor !== -1 && target !== -1) {
      const selected = new Set(state.base);
      for (const item of orderedIds.slice(Math.min(anchor, target), Math.max(anchor, target) + 1)) {
        selected.add(item);
      }
      return { ...state, selected };
    }
  }
  const selected = event.metaKey || event.ctrlKey ? new Set(state.selected) : new Set<string>();
  if ((event.metaKey || event.ctrlKey) && selected.has(id)) selected.delete(id);
  else selected.add(id);
  return { selected, base: selected, anchor: id };
}

export function pruneTaskSelection(
  state: TaskSelectionState,
  orderedIds: readonly string[],
): TaskSelectionState {
  const visible = new Set(orderedIds);
  const selected = new Set([...state.selected].filter((id) => visible.has(id)));
  const base = new Set([...state.base].filter((id) => visible.has(id)));
  const anchor = state.anchor !== null && visible.has(state.anchor) ? state.anchor : null;
  return selected.size === state.selected.size &&
    base.size === state.base.size &&
    anchor === state.anchor
    ? state
    : { selected, base, anchor };
}

/** Page-scoped selection shared by all visible lists. Keyboard commands live in TasksPage. */
export function useTaskSelection(orderedIds: readonly string[]) {
  const [state, setState] = useState(emptyTaskSelection);
  const pruned = pruneTaskSelection(state, orderedIds);
  if (pruned !== state) setState(pruned);
  const clear = useCallback(() => setState(emptyTaskSelection()), []);
  const handleRowClick = useCallback(
    (id: string, event: TaskSelectionClickEvent) => {
      setState((current) => selectTask(current, orderedIds, id, event));
    },
    [orderedIds],
  );
  return {
    selectedIds: pruned.selected,
    selectedCount: pruned.selected.size,
    handleRowClick,
    clear,
  };
}
