/**
 * The `cp_status_*` handlers, spread into the agents toolkit. Fork-owned.
 *
 * A coordinator reads and writes its own Project's board, and the user's
 * Assistant (the global Assistant Project's coordinator or a pinned channel)
 * also any Project in its reach, named by `projectId`. Standing agents also
 * hold the `agents` capability, so every call checks the caller's live role,
 * and the decider checks it again. Each write is one `project.status.set`
 * naming one workstream. When the Assistant writes another Project's board,
 * that Project's coordinator gets one short note per window.
 *
 * @module statusHandlers
 */
import {
  agentManagerRole,
  CommandId,
  isAssistantChannel,
  isProjectInAssistantReach,
  MessageId,
  countStatusesNeedingUser,
  isStatusAgentLive,
  type OrchestrationAgentMessageSource,
  ProjectId,
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

import { agentSendId } from "../../../orchestration/agentProtocol.ts";
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
  type StatusListInput,
  StatusOtherProjectError,
  type StatusSetInput,
} from "./tools.ts";

type StatusHandlers = Pick<
  Toolkit.HandlersFrom<Toolkit.Tools<typeof AgentsToolkit>>,
  "cp_status_list" | "cp_status_set"
>;

const readFailed = (cause: unknown) =>
  new AgentToolFailedError({ detail: "Could not read this Project's Status.", cause });

/** One note per Assistant thread and Project in each window, however many rows it edits. */
export const ASSISTANT_STATUS_NOTE_WINDOW_MS = 10 * 60 * 1000;

/** Message id of the coordinator note: the same inside one window, so a repeat dispatch is a no-op. */
export function assistantStatusNoteId(
  coordinatorId: string,
  assistantThreadId: string,
  nowMs: number,
): string {
  return agentSendId(
    coordinatorId,
    `status-note:${assistantThreadId}:${Math.floor(nowMs / ASSISTANT_STATUS_NOTE_WINDOW_MS)}`,
  );
}

/** What the coordinator reads: the first edit of the window, and where to see the rest. */
export function assistantStatusNoteText(change: ProjectStatusChange): string {
  const what =
    change.kind === "remove"
      ? `removed workstream [status:${change.id}]`
      : `updated workstream [status:${change.id}]`;
  return `The user's Assistant just edited your Status board: it ${what}. It may make more edits in the next few minutes. cp_status_list shows the board as it stands now. No reply needed; correct a row only if something is wrong.`;
}

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

  /**
   * Whose board the call touches, checked live: the caller's own Project for a
   * coordinator (a replaced one, or one whose Project was archived, is
   * refused), and for the Assistant also any live non-global Project in its
   * reach. `foreign` marks the Assistant crossing into another Project.
   */
  const requireBoard = Effect.fn("StatusTools.requireBoard")(function* (
    requested: string | undefined,
  ) {
    const invocation = yield* McpInvocationContext.requireMcpCapability("agents");
    const caller = yield* snapshots
      .getThreadShellById(invocation.threadId)
      .pipe(Effect.mapError(readFailed));
    if (Option.isNone(caller)) return yield* new StatusCoordinatorOnlyError();
    const home = yield* snapshots
      .getProjectShellById(caller.value.projectId)
      .pipe(Effect.mapError(readFailed));
    if (Option.isNone(home)) return yield* new StatusCoordinatorOnlyError();
    const own = { callerId: caller.value.id, projectId: home.value.id, foreign: false as const };
    if (isAssistantChannel(home.value, caller.value)) {
      if (requested === undefined || requested === home.value.id) return own;
      const target = yield* snapshots
        .getProjectShellById(ProjectId.make(requested))
        .pipe(Effect.mapError(readFailed));
      const marker = Option.getOrUndefined(target)?.assistant;
      const { assistant } = yield* settings.getSettings.pipe(Effect.mapError(readFailed));
      if (
        Option.isNone(target) ||
        marker == null ||
        marker.scope === "global" ||
        marker.archivedAt != null ||
        !isProjectInAssistantReach(assistant, target.value.id)
      ) {
        return yield* new AgentToolFailedError({
          detail: `'${requested}' is not a Project in your reach. Use a projectId from cp_assistant_overview.`,
        });
      }
      return {
        callerId: caller.value.id,
        projectId: target.value.id,
        foreign: true as const,
        messageCoordinators: assistant.messageCoordinators,
        coordinatorThreadId: marker.coordinatorThreadId,
      };
    }
    if (agentManagerRole(home.value, caller.value) !== "coordinator") {
      return yield* new StatusCoordinatorOnlyError();
    }
    if (requested !== undefined && requested !== home.value.id) {
      return yield* new StatusOtherProjectError();
    }
    return own;
  });

  /** Tells the owning coordinator once per window; best effort, never fails the edit. */
  const noteCoordinator = (
    board: {
      readonly callerId: ThreadId;
      readonly coordinatorThreadId: ThreadId;
    },
    change: ProjectStatusChange,
    createdAt: string,
  ) => {
    const id = assistantStatusNoteId(
      board.coordinatorThreadId,
      board.callerId,
      Date.parse(createdAt),
    );
    const source: OrchestrationAgentMessageSource = {
      kind: "agent",
      threadId: board.callerId,
      threadTitle: "Assistant",
    };
    return engine
      .dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make(id),
        threadId: board.coordinatorThreadId,
        message: {
          messageId: MessageId.make(id),
          text: assistantStatusNoteText(change),
          attachments: [],
          source,
        },
        createdAt,
      })
      .pipe(Effect.ignore);
  };

  const readStatuses = (projectId: ProjectId) =>
    projects.getById({ projectId }).pipe(
      Effect.mapError(readFailed),
      Effect.map((row) => Option.getOrUndefined(row)?.assistant?.statuses ?? []),
    );

  return {
    cp_status_list: (input: StatusListInput) =>
      Effect.gen(function* () {
        const { projectId } = yield* requireBoard(input.projectId);
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
        const board = yield* requireBoard(input.projectId);
        const { callerId, projectId } = board;
        const change = statusChangeOf(input);
        if (typeof change === "string") return yield* new AgentToolFailedError({ detail: change });
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* engine
          .dispatch({
            type: "project.status.set",
            commandId: CommandId.make(`mcp-status:${uuid}`),
            projectId,
            actorThreadId: callerId,
            change,
            createdAt,
          })
          .pipe(Effect.catchCause(changeFailed));
        if (board.foreign && board.messageCoordinators) {
          yield* noteCoordinator(board, change, createdAt);
        }
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
