import {
  homeForMove,
  taskAgentState,
  type TaskLifecycleProject,
  type TaskLifecycleThread,
} from "@t3tools/client-runtime/state/projects";
import { CalendarIcon } from "lucide-react";
import { useMemo } from "react";

import { useProjects, useThreadShells } from "../../state/entities";
import { useTaskToday, useTasks } from "../../state/tasks";
import { useHandToAssistant } from "../tasks/handToAssistant";
import { useExpandedTask } from "../tasks/TaskList";
import { TaskMoveMenu } from "../tasks/TaskMenus";
import { TaskRow, type TaskRowContext } from "../tasks/TaskRow";
import { useTaskActions } from "../tasks/useTaskActions";
import { railTodayTasks } from "./assistantRailTasks.logic";

// Fork-owned. Today's tasks in the Assistant rail, on the Tasks view's own
// row: check off, Move (Today, a date, week, month, year, backlog) on hover,
// and the row's own open gesture for the full detail. No drag here: the rail lists overdue
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
                // The Tasks row, plus its Move menu on hover: the collapsed row
                // only offers Move once expanded, and the rail is about
                // rescheduling at a glance.
                <li key={task.id} className="group/railtask relative list-none">
                  <ul className="flex flex-col">
                    <TaskRow
                      task={task}
                      state={taskAgentState(task, threads, lifecycleProjects)}
                      expanded={expanded}
                      onToggleExpanded={() => toggle(task.id)}
                      context={context}
                    />
                  </ul>
                  {expanded ? null : (
                    <TaskMoveMenu
                      home={task.home}
                      today={today}
                      className="absolute top-1 right-1 inline-flex size-7 cursor-pointer items-center justify-center rounded-md bg-card text-muted-foreground opacity-0 outline-none group-hover/railtask:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:opacity-100"
                      onMove={(target) =>
                        void actions.move(task, homeForMove(target, task.home, today))
                      }
                      onPickDate={(date) =>
                        void actions.move(
                          task,
                          homeForMove({ kind: "date", date }, task.home, today),
                        )
                      }
                    >
                      <CalendarIcon aria-hidden className="size-3.5" />
                    </TaskMoveMenu>
                  )}
                </li>
              );
            })}
          </ul>
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
