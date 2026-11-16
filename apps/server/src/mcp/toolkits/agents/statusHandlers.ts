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
  isStatusAgentLive,
  type ProjectId,
  type ProjectStatus,
  type ProjectStatusChange,
  sortProjectStatuses,
  type StatusAgentShell,
  statusStallMinutesOf,
  statusStallOf,
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
import * as ServerSettings from "../../../serverSettings.ts";
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

/**
 * The warning a write earns when the saved row claims work no agent is doing,
 * or undefined. `agents` holds the linked threads' shells, null when gone.
 */
export function statusWriteWarning(
  status: ProjectStatus | null,
  agents: ReadonlyArray<StatusAgentShell | null>,
  stallMinutes: number,
): string | undefined {
  if (status === null || stallMinutes <= 0 || status.dismissedAt !== undefined) return undefined;
  const linked = (status.agents?.length ?? 0) > 0;
  if (linked && (status.state === "working" || status.state === "queued")) {
    if (agents.some(isStatusAgentLive)) return undefined;
    return `This row says ${status.state}, but none of its agents is running. If nobody is on it now, set it to queued, done or needs-you, or link the agent that is. Left as is, the user sees it as Stalled after ${stallMinutes} minutes.`;
  }
  if (!linked && status.state === "working") {
    return `This row says working with no agent linked. Link the agent doing it (agents), or the user sees it as Stalled once it goes ${stallMinutes} minutes without an update.`;
  }
  return undefined;
}

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
  const settings = yield* ServerSettings.ServerSettingsService;

  const stallMinutes = settings.getSettings.pipe(
    Effect.map((current) => statusStallMinutesOf(current.statusStallMinutes)),
    Effect.orElseSucceed(() => statusStallMinutesOf(undefined)),
  );

  /** Linked agents' shells; an unreadable one counts as gone. */
  const agentShells = (status: ProjectStatus) =>
    Effect.forEach(status.agents ?? [], (threadId) =>
      snapshots.getThreadShellById(threadId).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      ),
    );

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
        const statuses = sortProjectStatuses(yield* readStatuses(projectId));
        const minutes = yield* stallMinutes;
        const nowMs = Date.parse(DateTime.formatIso(yield* DateTime.now));
        const stalled = yield* Effect.forEach(statuses, (status) =>
          agentShells(status).pipe(
            Effect.map((agents) => {
              const stall = statusStallOf(status, agents, nowMs, minutes);
              return stall === null ? [] : [{ id: status.id, reason: stall.reason }];
            }),
          ),
        ).pipe(Effect.map((rows) => rows.flat()));
        return { statuses, ...(stalled.length > 0 ? { stalled } : {}) };
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
        const saved = statuses.find((status) => status.id === input.id) ?? null;
        const warning =
          saved === null
            ? undefined
            : statusWriteWarning(saved, yield* agentShells(saved), yield* stallMinutes);
        return {
          id: input.id,
          status: saved,
          needsYou: countStatusesNeedingUser(statuses),
          ...(warning !== undefined ? { warning } : {}),
        };
      }),
  } satisfies StatusHandlers;
});
