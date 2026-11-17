import {
  homeForMove,
  taskAgentState,
  type TaskLifecycleProject,
  type TaskLifecycleThread,
} from "@t3tools/client-runtime/state/projects";
import { useMemo, useState } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { openTaskQuickAdd } from "../tasks/QuickAddDialog";
import { useTasksKeyboard } from "../tasks/useTasksKeyboard";
import { useProjects, useThreadShells } from "../../state/entities";
import { useTaskToday, useTasks } from "../../state/tasks";
import { useHandToAssistant } from "../tasks/handToAssistant";
import { useExpandedTask } from "../tasks/TaskList";
import { TaskMoveMenu } from "../tasks/TaskMenus";
import { TaskRow, type TaskRowContext } from "../tasks/TaskRow";
import { useTaskActions } from "../tasks/useTaskActions";
import { useTaskSelection } from "../tasks/useTaskSelection";
import { railTodayTasks } from "./assistantRailTasks.logic";

// Fork-owned. Today's tasks in the Assistant rail, on the Tasks view's own
// row: check off, click to select and double-click to open the full detail,
// and Move (Today, a date, week, month, year, backlog) on hover. No drag here: the rail lists overdue
// first, which is not the user's order, so a reorder would read wrong.

export function AssistantTodayTasks(props: { readonly onOpenTasks: () => void }) {
  const today = useTaskToday();
  const { environmentId, tasks } = useTasks();
  const projects = useProjects();
  const threads = useThreadShells() as ReadonlyArray<TaskLifecycleThread>;
  const actions = useTaskActions(environmentId);
  const handToAssistant = useHandToAssistant();
  const { expandedId, toggle } = useExpandedTask();
  const { shown, more, total } = useMemo(() => railTodayTasks(tasks, today), [tasks, today]);
  const shownIds = useMemo(() => shown.map((task) => task.id as string), [shown]);
  const selection = useTaskSelection(shownIds);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [moveRequest, setMoveRequest] = useState<{ id: string; sequence: number } | null>(null);
  const [bulkMoveRequest, setBulkMoveRequest] = useState(0);
  const selectedTasks = shown.filter((task) => selection.selectedIds.has(task.id));
  useTasksKeyboard({
    expandedId,
    selectedIds: selectedTasks.map((task) => task.id),
    hoveredId,
    orderedIds: shownIds,
    isBlocked: () =>
      isCommandPaletteOpen() ||
      (selection.selectedCount === 0 && hoveredId === null && expandedId === null),
    onExpand: toggle,
    onClear: selection.clear,
    onDelete: (ids) => {
      for (const task of shown) if (ids.includes(task.id)) void actions.delete(task);
    },
    onNew: openTaskQuickAdd,
    onMove: (id) => setMoveRequest((current) => ({ id, sequence: (current?.sequence ?? 0) + 1 })),
    onMoveSelection: () => setBulkMoveRequest((current) => current + 1),
  });
  const context: TaskRowContext = {
    today,
    actions,
    projects,
    onHandToAssistant: (task) => void handToAssistant(task),
  };
  const lifecycleProjects = projects as ReadonlyArray<TaskLifecycleProject>;

  return (
    <section aria-labelledby="assistant-rail-today" className="mt-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <h3 id="assistant-rail-today" className="font-medium text-foreground">
          Today
        </h3>
        <span className="tabular-nums">
          {total} {total === 1 ? "task" : "tasks"}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="cursor-pointer font-medium hover:text-foreground"
          onClick={props.onOpenTasks}
        >
          Open Tasks
        </button>
      </div>
      {shown.length > 0 ? (
        <div className="rounded-xl border border-border bg-card px-1.5 py-1">
          <ul
            aria-label="Today's tasks"
            className="flex flex-col"
            data-testid="assistant-rail-tasks"
          >
            {shown.map((task) => {
              const expanded = expandedId === task.id;
              return (
                <li key={task.id} className="group/railtask relative list-none">
                  <ul className="flex flex-col">
                    <TaskRow
                      moveRequest={moveRequest?.id === task.id ? moveRequest.sequence : 0}
                      onHover={(hovered) => setHoveredId(hovered ? task.id : null)}
                      task={task}
                      state={taskAgentState(task, threads, lifecycleProjects)}
                      expanded={expanded}
                      onToggleExpanded={() => {
                        setMoveRequest(null);
                        toggle(task.id);
                      }}
                      context={context}
                      draggable={false}
                      reorderable={false}
                      selected={selection.selectedIds.has(task.id)}
                      onSelectClick={(event) => {
                        // A plain click on a member of a batch keeps the batch, so a
                        // double-click to open never discards it (as on the Tasks page).
                        if (
                          !event.metaKey &&
                          !event.ctrlKey &&
                          !event.shiftKey &&
                          selection.selectedIds.size > 1 &&
                          selection.selectedIds.has(task.id)
                        )
                          return;
                        selection.handleRowClick(task.id, event);
                      }}
                    />
                  </ul>
                </li>
              );
            })}
          </ul>
          {selectedTasks.length > 0 ? (
            <div
              aria-label="Selected task actions"
              className="flex items-center gap-2 px-2 py-1 text-xs"
            >
              <span>{selectedTasks.length} selected</span>
              <TaskMoveMenu
                home={selectedTasks[0]!.home}
                today={today}
                openRequest={bulkMoveRequest}
                onMove={(target) => {
                  for (const task of selectedTasks)
                    void actions.move(task, homeForMove(target, task.home, today));
                }}
                onPickDate={(date) => {
                  for (const task of selectedTasks)
                    void actions.move(task, homeForMove({ kind: "date", date }, task.home, today));
                }}
              >
                Move
              </TaskMoveMenu>
              <button
                type="button"
                onClick={() => {
                  for (const task of selectedTasks) void actions.delete(task);
                }}
              >
                Delete
              </button>
              <button type="button" onClick={selection.clear}>
                Clear selection
              </button>
            </div>
          ) : null}
          {more > 0 ? (
            <button
              type="button"
              className="w-full cursor-pointer px-2 py-1.5 text-start text-xs text-muted-foreground hover:text-foreground"
              onClick={props.onOpenTasks}
            >
              +{more} more
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
