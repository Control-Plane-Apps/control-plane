import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  formatTaskHome,
  formatTaskTime,
  proposedTasksForProject,
  taskForThread,
} from "@t3tools/client-runtime/state/projects";
import type { ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ListTodoIcon } from "lucide-react";

import { useProjects } from "../../state/entities";
import { useTaskToday, useTasks } from "../../state/tasks";
import { ProposedTasks } from "./TaskList";
import { useTaskActions } from "./useTaskActions";

/**
 * Under a thread's header: the task this thread is working on (any thread),
 * and, on a coordinator, the tasks it proposed that wait for the user.
 */
export function ThreadTaskBar(props: {
  readonly threadId: ThreadId;
  readonly project: EnvironmentProject | null;
  readonly isCoordinator: boolean;
}) {
  const { environmentId, tasks } = useTasks();
  const today = useTaskToday();
  const actions = useTaskActions(environmentId);
  const projects = useProjects();
  if (environmentId === null) return null;
  const linked = taskForThread(tasks, props.threadId);
  const proposals =
    props.isCoordinator && props.project !== null
      ? proposedTasksForProject(tasks, props.project.id)
      : [];
  if (linked === undefined && proposals.length === 0) return null;
  const reminder = linked?.home.kind === "date" ? linked.home.reminderTime : undefined;
  return (
    <div className="flex flex-col gap-2 border-border border-b bg-background px-5 py-2">
      {linked !== undefined ? (
        <div className="flex min-w-0 items-center gap-2 text-xs" aria-label="Linked task">
          <ListTodoIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-medium text-foreground">{linked.title}</span>
          <span className="shrink-0 text-muted-foreground">
            {formatTaskHome(linked.home, today)}
            {reminder !== undefined ? ` · ${formatTaskTime(reminder)}` : ""}
          </span>
          <Link
            to="/tasks/$view"
            params={{ view: linked.home.kind === "period" ? linked.home.horizon : "today" }}
            className="ms-auto shrink-0 text-muted-foreground hover:text-foreground"
          >
            Open in Tasks
          </Link>
          <button
            type="button"
            className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
            onClick={() => {
              const { threadId: _drop, ...rest } = linked.links ?? {};
              void actions.patch(linked, { links: rest });
              if (linked.handoff?.threadId === props.threadId) void actions.handOff(linked, null);
            }}
          >
            Unlink
          </button>
        </div>
      ) : null}
      {proposals.length > 0 ? (
        <div className="mx-auto w-full max-w-3xl">
          <ProposedTasks
            tasks={proposals}
            variant="card"
            showWorkstream
            context={{ today, actions, projects, onHandToAgent: () => undefined }}
          />
        </div>
      ) : null}
    </div>
  );
}
