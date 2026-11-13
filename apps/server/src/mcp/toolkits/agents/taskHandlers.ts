/**
 * The `cp_task_*` handlers, spread into the agents toolkit. Fork-owned.
 *
 * Coordinator only, checked live here and again in the decider. A coordinator
 * can list tasks linked to its Project and propose new ones; only the user
 * adds, dismisses, edits or completes a task.
 *
 * @module taskHandlers
 */
import {
  agentManagerRole,
  CommandId,
  isProposedTask,
  localTaskDate,
  addTaskDays,
  taskPeriodFor,
  TaskId,
  type Task,
  type TaskHome,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Toolkit from "effect/unstable/ai/Toolkit";

import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  type AgentsToolkit,
  AgentToolFailedError,
  StatusCoordinatorOnlyError,
  type TaskProposeInput,
} from "./tools.ts";

type TaskHandlers = Pick<
  Toolkit.HandlersFrom<Toolkit.Tools<typeof AgentsToolkit>>,
  "cp_task_list" | "cp_task_propose"
>;

const readFailed = (cause: unknown) =>
  new AgentToolFailedError({ detail: "Could not read the user's tasks.", cause });

const isInvariantError = Schema.is(OrchestrationCommandInvariantError);

const proposeFailed = <E>(cause: Cause.Cause<E>): Effect.Effect<never, AgentToolFailedError> => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
  const error = Cause.findErrorOption(cause);
  const detail =
    Option.isSome(error) && isInvariantError(error.value)
      ? error.value.detail
      : "Could not propose the task.";
  return Effect.fail(new AgentToolFailedError({ detail, cause }));
};

/** The tool's `when` as a task home, counted from the server's local today. */
export function taskHomeOf(when: TaskProposeInput["when"], today: string): TaskHome {
  switch (when) {
    case "today":
      return { kind: "date", date: today };
    case "tomorrow":
      return { kind: "date", date: addTaskDays(today, 1) };
    case "this-month":
      return { kind: "period", horizon: "month", ...taskPeriodFor("month", today) };
    case "backlog":
      return { kind: "backlog", horizon: null };
    case "this-week":
    case undefined:
      return { kind: "period", horizon: "week", ...taskPeriodFor("week", today) };
  }
}

export const makeTaskHandlers = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const requireCoordinator = Effect.fn("TaskTools.requireCoordinator")(function* () {
    const invocation = yield* McpInvocationContext.requireMcpCapability("agents");
    const caller = yield* snapshots
      .getThreadShellById(invocation.threadId)
      .pipe(Effect.mapError(readFailed));
    if (Option.isNone(caller)) return yield* new StatusCoordinatorOnlyError();
    const project = yield* snapshots
      .getProjectShellById(caller.value.projectId)
      .pipe(Effect.mapError(readFailed));
    if (Option.isNone(project) || agentManagerRole(project.value, caller.value) !== "coordinator") {
      return yield* new StatusCoordinatorOnlyError();
    }
    return { callerId: caller.value.id, projectId: project.value.id };
  });

  const projectTasks = (projectId: string) =>
    snapshots.getCommandReadModel().pipe(
      Effect.mapError(readFailed),
      Effect.map((model): Task[] =>
        (model.tasks ?? []).filter(
          (task) =>
            task.status === "todo" &&
            (task.links?.projectId === projectId || task.proposal?.projectId === projectId),
        ),
      ),
    );

  return {
    cp_task_list: () =>
      Effect.gen(function* () {
        const { projectId } = yield* requireCoordinator();
        return { tasks: yield* projectTasks(projectId) };
      }),

    cp_task_propose: (input) =>
      Effect.gen(function* () {
        const { callerId, projectId } = yield* requireCoordinator();
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const taskId = TaskId.make(uuid);
        yield* engine
          .dispatch({
            type: "task.propose",
            commandId: CommandId.make(`mcp-task:${uuid}`),
            taskId,
            projectId,
            actorThreadId: callerId,
            title: input.title,
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            home: taskHomeOf(
              input.when,
              localTaskDate(DateTime.toEpochMillis(yield* DateTime.now)),
            ),
            ...(input.statusId !== undefined ? { statusId: input.statusId } : {}),
            createdAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(Effect.catchCause(proposeFailed));
        const tasks = yield* projectTasks(projectId);
        const task = tasks.find((entry) => entry.id === taskId);
        if (task === undefined) {
          return yield* new AgentToolFailedError({ detail: "The proposal was not saved." });
        }
        return {
          task,
          proposed: tasks.filter((entry) => isProposedTask(entry)).length,
        };
      }),
  } satisfies TaskHandlers;
});
