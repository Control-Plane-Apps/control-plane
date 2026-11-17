import { useEffect } from "react";

export interface TasksKeyboardOptions {
  readonly expandedId: string | null;
  readonly selectedIds: readonly string[];
  readonly hoveredId: string | null;
  readonly orderedIds: readonly string[];
  readonly isBlocked: () => boolean;
  readonly onExpand: (id: string) => void;
  readonly onClear: () => void;
  readonly onDelete: (ids: readonly string[]) => void;
  readonly onNew: () => void;
  readonly onMove: (id: string) => void;
  readonly onMoveSelection?: () => void;
}

export function handleTasksKey(event: KeyboardEvent, options: TasksKeyboardOptions) {
  if (event.defaultPrevented || options.isBlocked()) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  const typing = target?.isContentEditable || target?.closest("input,textarea,select");
  if (
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "n"
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (typing) return;
    options.onNew();
    return;
  }
  if (event.key === "Escape") {
    if (typing || target?.closest('[role="menu"],[role="dialog"]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (options.expandedId !== null) options.onExpand(options.expandedId);
    options.onClear();
    return;
  }
  const selectedIds = options.selectedIds.filter((id) => options.orderedIds.includes(id));
  const hoveredId =
    options.hoveredId !== null && options.orderedIds.includes(options.hoveredId)
      ? options.hoveredId
      : null;
  const deleteIds = selectedIds.length > 0 ? selectedIds : hoveredId === null ? [] : [hoveredId];
  if (
    (event.key === "Delete" || event.key === "Backspace") &&
    deleteIds.length > 0 &&
    !typing &&
    !target?.closest('[role="menu"],[role="dialog"]')
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    options.onDelete(deleteIds);
    return;
  }
  if (
    event.key.toLowerCase() !== "s" ||
    event.metaKey === event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.repeat
  )
    return;
  if (target?.closest('[role="menu"],[role="dialog"]')) return;
  if (selectedIds.length > 1) {
    if (typing || options.onMoveSelection === undefined) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    options.onMoveSelection();
    return;
  }
  const id = selectedIds[0] ?? hoveredId ?? options.expandedId;
  if (!id || !options.orderedIds.includes(id)) return;
  if (typing && target?.closest("[data-task-id]")?.getAttribute("data-task-id") !== id) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  options.onMove(id);
}

/** Shared by Tasks and active Assistant task rows; captures before shell bindings. */
export function useTasksKeyboard(options: TasksKeyboardOptions) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => handleTasksKey(event, options);
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  });
}
