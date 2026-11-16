import { useEffect } from "react";

export interface TasksKeyboardOptions {
  readonly expandedId: string | null;
  readonly selectedIds: readonly string[];
  readonly hoveredId: string | null;
  readonly orderedIds: readonly string[];
  readonly isBlocked: () => boolean;
  readonly onExpand: (id: string) => void;
  readonly onClear: () => void;
  readonly onDelete: () => void;
  readonly onNew: () => void;
  readonly onMove: (id: string) => void;
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
    if (options.expandedId !== null) {
      event.preventDefault();
      options.onExpand(options.expandedId);
    } else options.onClear();
    return;
  }
  if (
    (event.key === "Delete" || event.key === "Backspace") &&
    options.selectedIds.length > 0 &&
    !typing &&
    !target?.closest('[role="menu"],[role="dialog"]')
  ) {
    event.preventDefault();
    options.onDelete();
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
  if (options.selectedIds.length > 1) return;
  const id = options.selectedIds[0] ?? options.hoveredId ?? options.expandedId;
  if (!id || !options.orderedIds.includes(id)) return;
  if (typing && target?.closest("[data-task-id]")?.getAttribute("data-task-id") !== id) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (options.expandedId !== id) options.onExpand(id);
  options.onMove(id);
}

/** Mounted only in Tasks, capturing Cmd+N before the shell's New Chat binding. */
export function useTasksKeyboard(options: TasksKeyboardOptions) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => handleTasksKey(event, options);
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  });
}
