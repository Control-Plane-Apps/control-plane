/**
 * The `cp_status_*` handlers, spread into the agents toolkit. Fork-owned.
 *
 * Coordinator only: standing agents also hold the `agents` capability, so
 * every call checks the caller's live role, and the decider checks it again.
 * Each write is one `project.status.set` naming one workstream.
 *
 * @module statusHandlers
 */
import {
  agentManagerRole,
  CommandId,
  countStatusesNeedingUser,
  type ProjectId,
  type ProjectStatusChange,
  sortProjectStatuses,
  ThreadId,
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
import { ProjectionProjectRepository } from "../../../persistence/Services/ProjectionProjects.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  type AgentsToolkit,
  AgentToolFailedError,
  StatusCoordinatorOnlyError,
  type StatusSetInput,
} from "./tools.ts";

type StatusHandlers = Pick<
  Toolkit.HandlersFrom<Toolkit.Tools<typeof AgentsToolkit>>,
  "cp_status_list" | "cp_status_set"
>;

const readFailed = (cause: unknown) =>
  new AgentToolFailedError({ detail: "Could not read this Project's Status.", cause });

const isInvariantError = Schema.is(OrchestrationCommandInvariantError);

/** The decider's reason (a length, a duplicate title, a past deadline) reaches the agent as written. */
const changeFailed = <E>(cause: Cause.Cause<E>): Effect.Effect<never, AgentToolFailedError> => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
  const error = Cause.findErrorOption(cause);
  const detail =
    Option.isSome(error) && isInvariantError(error.value)
      ? error.value.detail
      : "Could not save the status.";
  return Effect.fail(new AgentToolFailedError({ detail, cause }));
};

/** Tool input to the command's change. Flat on the wire because OpenCode stringifies nested unions. */
export function statusChangeOf(input: StatusSetInput): ProjectStatusChange | string {
  if (input.remove === true) return { kind: "remove", id: input.id };
  const deadline =
    input.deadline === undefined
      ? undefined
      : input.deadline.trim().length === 0
        ? null
        : input.deadline.trim();
  if (deadline != null && Number.isNaN(Date.parse(deadline))) {
    return `Deadline '${deadline}' is not an ISO date-time.`;
  }
  return {
    kind: "upsert",
    id: input.id,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    ...(input.agents !== undefined ? { agents: input.agents.map((id) => ThreadId.make(id)) } : {}),
    ...(input.question !== undefined ? { question: input.question } : {}),
    ...(input.recommendation !== undefined ? { recommendation: input.recommendation } : {}),
    ...(input.answer !== undefined ? { answer: input.answer } : {}),
    ...(input.why !== undefined ? { why: input.why } : {}),
    ...(deadline !== undefined
      ? {
          deadline:
            deadline === null
              ? null
              : DateTime.formatIso(DateTime.makeUnsafe(Date.parse(deadline))),
        }
      : {}),
    ...(input.clearDecision !== undefined ? { clearDecision: input.clearDecision } : {}),
  };
}

export const makeStatusHandlers = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const projects = yield* ProjectionProjectRepository;
  const crypto = yield* Crypto.Crypto;

  /** The role is checked live, so a replaced coordinator, or one whose Project was archived, is refused. */
  const requireCoordinator = Effect.fn("StatusTools.requireCoordinator")(function* () {
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

  const readStatuses = (projectId: ProjectId) =>
    projects.getById({ projectId }).pipe(
      Effect.mapError(readFailed),
      Effect.map((row) => Option.getOrUndefined(row)?.assistant?.statuses ?? []),
    );

  return {
    cp_status_list: () =>
      Effect.gen(function* () {
        const { projectId } = yield* requireCoordinator();
        return { statuses: sortProjectStatuses(yield* readStatuses(projectId)) };
      }),

    cp_status_set: (input) =>
      Effect.gen(function* () {
        const { callerId, projectId } = yield* requireCoordinator();
        const change = statusChangeOf(input);
        if (typeof change === "string") return yield* new AgentToolFailedError({ detail: change });
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        yield* engine
          .dispatch({
            type: "project.status.set",
            commandId: CommandId.make(`mcp-status:${uuid}`),
            projectId,
            actorThreadId: callerId,
            change,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(Effect.catchCause(changeFailed));
        const statuses = yield* readStatuses(projectId);
        return {
          id: input.id,
          status: statuses.find((status) => status.id === input.id) ?? null,
          needsYou: countStatusesNeedingUser(statuses),
        };
      }),
  } satisfies StatusHandlers;
});
