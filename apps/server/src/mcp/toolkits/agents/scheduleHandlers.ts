/**
 * The `cp_schedule_*` handlers, spread into the agents toolkit. Fork-owned.
 *
 * Coordinator only: M3 also grants `agents` to standing agents, so every call
 * checks the caller's live role. Each write is one
 * `project.schedule.agent-change`, so an agent never touches a schedule it did
 * not name, and the decider pauses a schedule an agent creates, re-prompts,
 * re-times or retargets unless the change turns it on. Turning one on needs
 * the caller's running turn to have been started by the user's own message:
 * a turn an agent result, peer message or schedule run started (its message
 * has a `source`) never can. Whether that message asked to turn the schedule
 * on is the coordinator's judgment, per its instructions; the server cannot
 * read intent.
 *
 * @module scheduleHandlers
 */
import {
  agentManagerRole,
  CommandId,
  isAssistantChannel,
  isProjectInAssistantReach,
  ProjectId,
  type ReachRemoteActor,
  type ThreadId,
  isStandingAgent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProjectAssistant,
  type ProjectScheduleAgentChange,
  type ProjectScheduleTarget,
} from "@t3tools/contracts";
import { describeCadence, newScheduleId, nextScheduleRuns } from "@t3tools/shared/schedules";
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
import { ProjectionThreadMessageRepository } from "../../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";
import { HostTimeZoneSource } from "../../../schedules/hostZone.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { agentRefCandidates } from "./agentScope.ts";
import {
  AgentAmbiguousError,
  AgentNotFoundError,
  type AgentsToolkit,
  AgentToolFailedError,
  ScheduleNotFoundError,
  SchedulesCoordinatorOnlyError,
  ScheduleTurnOnNotRequestedError,
  ScheduleCreateResult,
  type ScheduleCreateInput,
  ScheduleDeleteResult,
  type ScheduleDeleteInput,
  ScheduleListResult,
  ScheduleUpdateResult,
  type ScheduleUpdateInput,
} from "./tools.ts";
import { Reach, type ReachMachine } from "../../../reach/Reach.ts";
import * as ServerSettings from "../../../serverSettings.ts";

type ScheduleToolName =
  | "cp_schedule_list"
  | "cp_schedule_create"
  | "cp_schedule_update"
  | "cp_schedule_delete";

type ScheduleHandlers = Pick<
  Toolkit.HandlersFrom<Toolkit.Tools<typeof AgentsToolkit>>,
  ScheduleToolName
>;

/**
 * Whose schedules a call manages and who acts: the Project's coordinator, or
 * the user's Assistant (here, or on a linked server through the reach route).
 */
export interface ScheduleScope {
  readonly project: Pick<OrchestrationProjectShell, "id" | "assistant">;
  readonly actorThreadId: ThreadId;
  readonly remoteActor?: ReachRemoteActor | undefined;
  /** Fails unless the acting turn was started by the user's own message. */
  readonly requireUserTurn: Effect.Effect<
    void,
    ScheduleTurnOnNotRequestedError | AgentToolFailedError
  >;
}

type ScheduleTargetResolution =
  | { readonly kind: "found"; readonly target: ProjectScheduleTarget }
  | { readonly kind: "not-found" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "not-standing" };

/**
 * `"coordinator"`, or a live standing agent of the Project named by threadId
 * or exact title. The coordinator named by its own id or title reads as
 * `"coordinator"`, which follows the role.
 */
function resolveScheduleTarget(
  ref: string,
  input: {
    readonly project: Pick<OrchestrationProjectShell, "id" | "assistant">;
    readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  },
): ScheduleTargetResolution {
  const trimmed = ref.trim();
  if (trimmed.toLowerCase() === "coordinator") return { kind: "found", target: "coordinator" };
  const { project } = input;
  const coordinatorId = project.assistant?.coordinatorThreadId;
  const candidates = agentRefCandidates(trimmed, {
    threads: input.threads.filter(
      (thread) => thread.projectId === project.id && thread.archivedAt === null,
    ),
    projectId: project.id,
  });
  const eligible = candidates.filter(
    (thread) => thread.id === coordinatorId || isStandingAgent(project, thread),
  );
  const [only] = eligible;
  if (eligible.length === 1 && only !== undefined) {
    return { kind: "found", target: only.id === coordinatorId ? "coordinator" : only.id };
  }
  if (eligible.length > 1) return { kind: "ambiguous" };
  return { kind: candidates.length === 0 ? "not-found" : "not-standing" };
}

/** Own keys only: a schedule id such as "constructor" must not read Object.prototype. */
function entryOf<T>(record: Readonly<Record<string, T>> | undefined, id: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, id) ? record[id] : undefined;
}

const readFailed = (cause: unknown) =>
  new AgentToolFailedError({ detail: "Could not read this Project's schedules.", cause });

const isInvariantError = Schema.is(OrchestrationCommandInvariantError);

/** The decider's reason (a bad cron, target or length) reaches the agent as written. */
const changeFailed = <E>(cause: Cause.Cause<E>): Effect.Effect<never, AgentToolFailedError> => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
  const error = Cause.findErrorOption(cause);
  const detail =
    Option.isSome(error) && isInvariantError(error.value)
      ? error.value.detail
      : "Could not save the schedule.";
  return Effect.fail(new AgentToolFailedError({ detail, cause }));
};

/** Needs the project repository: the shell leaves out prompts. */
export const makeScheduleCore = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const projects = yield* ProjectionProjectRepository;
  const messages = yield* ProjectionThreadMessageRepository;
  const turns = yield* ProjectionTurnRepository;
  const hostZone = yield* HostTimeZoneSource;
  const crypto = yield* Crypto.Crypto;

  /** The next slot in the zone the host scheduler fires in; null while paused. */
  const nextRunOf = (schedule: { readonly cron: string; readonly enabled: boolean }) =>
    Effect.map(DateTime.now, (now) => {
      if (!schedule.enabled) return null;
      const [next] = nextScheduleRuns(schedule.cron, hostZone().zone, DateTime.toDateUtc(now), 1);
      return next === undefined ? null : next.toISOString();
    });

  /**
   * Turning a schedule on is the user's call, so the caller's running turn
   * must have been started by the user's own message. Agent results, peer
   * messages and schedule runs carry a `source`; one that arrives mid-turn
   * does not change which message started the turn.
   */
  const requireUserTurn = Effect.fn("ScheduleTools.requireUserTurn")(function* (
    caller: OrchestrationThreadShell,
  ) {
    const turnId =
      caller.session?.activeTurnId ??
      (caller.latestTurn?.state === "running" ? caller.latestTurn.turnId : null);
    if (turnId === null) return yield* new ScheduleTurnOnNotRequestedError();
    const turn = yield* turns
      .getByTurnId({ threadId: caller.id, turnId })
      .pipe(Effect.mapError(readFailed));
    const messageId = Option.getOrUndefined(turn)?.pendingMessageId ?? null;
    if (Option.isNone(turn) || messageId === null)
      return yield* new ScheduleTurnOnNotRequestedError();
    const message = Option.getOrUndefined(
      yield* messages.getByMessageId({ messageId }).pipe(Effect.mapError(readFailed)),
    );
    if (
      message === undefined ||
      message.threadId !== caller.id ||
      message.role !== "user" ||
      message.source !== undefined
    ) {
      return yield* new ScheduleTurnOnNotRequestedError();
    }
    // A thread keeps one pending start, so a later request can overwrite an
    // agent's before its turn runs, and the turn is then credited to the
    // later message. Refuse when any agent or schedule message arrived since
    // the previous turn was requested, and when the starting message predates
    // that turn (a replay of an old message).
    const requestedAt = Date.parse(turn.value.requestedAt);
    const previous = (yield* turns
      .listByThreadId({ threadId: caller.id })
      .pipe(Effect.mapError(readFailed)))
      .filter((row) => row.turnId !== turnId && Date.parse(row.requestedAt) < requestedAt)
      .reduce((latest, row) => Math.max(latest, Date.parse(row.requestedAt)), -Infinity);
    const startedAt = Date.parse(message.createdAt);
    if (startedAt <= previous) return yield* new ScheduleTurnOnNotRequestedError();
    const thread = yield* messages
      .listByThreadId({ threadId: caller.id })
      .pipe(Effect.mapError(readFailed));
    const agentSent = thread.some((entry) => {
      const at = Date.parse(entry.createdAt);
      return (
        entry.role === "user" && entry.source !== undefined && at > previous && at <= startedAt
      );
    });
    if (agentSent) return yield* new ScheduleTurnOnNotRequestedError();
  });

  /** The full marker, prompts included. */
  const readMarker = (scope: ScheduleScope) =>
    projects.getById({ projectId: scope.project.id }).pipe(
      Effect.mapError(readFailed),
      Effect.map((row): ProjectAssistant | null => Option.getOrUndefined(row)?.assistant ?? null),
    );

  const requireSchedule = Effect.fn("ScheduleTools.requireSchedule")(function* (
    scope: ScheduleScope,
    id: string,
  ) {
    const marker = yield* readMarker(scope);
    const schedule = marker?.schedules?.find((entry) => entry.id === id);
    if (schedule === undefined) return yield* new ScheduleNotFoundError({ id });
    return { schedule, prompt: entryOf(marker?.schedulePrompts, id) };
  });

  const requireTarget = Effect.fn("ScheduleTools.requireTarget")(function* (
    scope: ScheduleScope,
    ref: string,
  ) {
    const snapshot = yield* snapshots.getShellSnapshot().pipe(Effect.mapError(readFailed));
    const resolved = resolveScheduleTarget(ref, {
      project: scope.project,
      threads: snapshot.threads,
    });
    switch (resolved.kind) {
      case "found":
        return resolved.target;
      case "ambiguous":
        return yield* new AgentAmbiguousError({ agent: ref });
      case "not-found":
        return yield* new AgentNotFoundError({ agent: ref });
      case "not-standing":
        return yield* new AgentToolFailedError({
          detail: `Schedules run in the coordinator or a standing agent. '${ref}' is neither.`,
        });
    }
  });

  const dispatchChange = Effect.fn("ScheduleTools.dispatchChange")(function* (
    scope: ScheduleScope,
    change: ProjectScheduleAgentChange,
  ) {
    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* engine
      .dispatch({
        type: "project.schedule.agent-change",
        commandId: CommandId.make(`mcp-schedule:${uuid}`),
        projectId: scope.project.id,
        actorThreadId: scope.actorThreadId,
        ...(scope.remoteActor !== undefined ? { remoteActor: scope.remoteActor } : {}),
        change,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      })
      .pipe(Effect.catchCause(changeFailed));
  });

  return {
    requireUserTurn,
    list: (coordinator: ScheduleScope) =>
      Effect.gen(function* () {
        const marker = yield* readMarker(coordinator);
        const schedules = yield* Effect.forEach(marker?.schedules ?? [], (schedule) =>
          Effect.map(nextRunOf(schedule), (nextRun) => ({
            id: schedule.id,
            name: schedule.name,
            prompt: entryOf(marker?.schedulePrompts, schedule.id) ?? "",
            cron: schedule.cron,
            cadence: describeCadence(schedule.cron),
            target: schedule.target,
            enabled: schedule.enabled,
            nextRun,
            createdBy: schedule.createdBy,
            updatedBy: schedule.updatedBy,
            lastRun: entryOf(marker?.scheduleRuns, schedule.id) ?? null,
          })),
        );
        return { schedules };
      }),

    create: (coordinator: ScheduleScope, input: ScheduleCreateInput) =>
      Effect.gen(function* () {
        const target =
          input.target === undefined ? undefined : yield* requireTarget(coordinator, input.target);
        const enabled = input.enabled === true;
        if (enabled) yield* coordinator.requireUserTurn;
        const taken = new Set(
          ((yield* readMarker(coordinator))?.schedules ?? []).map((schedule) => schedule.id),
        );
        // An upsert on a taken id would edit that schedule instead.
        let id = newScheduleId(input.name);
        while (taken.has(id)) id = newScheduleId(input.name);
        yield* dispatchChange(coordinator, {
          kind: "upsert",
          id,
          name: input.name,
          prompt: input.prompt,
          cron: input.cron,
          ...(target === undefined ? {} : { target }),
          ...(enabled ? { enabled } : {}),
        });
        const { schedule: created } = yield* requireSchedule(coordinator, id);
        return {
          id,
          enabled: created.enabled,
          nextRun: yield* nextRunOf(created),
          note: created.enabled
            ? "On. It first runs at nextRun, not now."
            : "Saved paused. Turn it on only when the user asks.",
        };
      }),

    update: (coordinator: ScheduleScope, input: ScheduleUpdateInput) =>
      Effect.gen(function* () {
        const { schedule: existing, prompt } = yield* requireSchedule(coordinator, input.id);
        const target =
          input.target === undefined ? undefined : yield* requireTarget(coordinator, input.target);
        const storedTarget =
          existing.target === coordinator.project.assistant?.coordinatorThreadId
            ? "coordinator"
            : existing.target;
        // Values equal to the stored ones are dropped: any write, even one that
        // changes nothing, moves the Project in the sidebar.
        const fields = {
          ...(input.name === undefined || input.name === existing.name ? {} : { name: input.name }),
          ...(input.prompt === undefined || input.prompt === prompt
            ? {}
            : { prompt: input.prompt }),
          ...(input.cron === undefined || input.cron === existing.cron ? {} : { cron: input.cron }),
          ...(target === undefined || target === storedTarget ? {} : { target }),
        };
        // `pause` is the older spelling: true pauses, false never turned one on.
        if (input.pause === true && input.enabled === true) {
          return yield* new AgentToolFailedError({
            detail: "Pass enabled or pause, not both: they disagree.",
          });
        }
        const requested = input.enabled ?? (input.pause === true ? false : undefined);
        // A new prompt, cron or target pauses the schedule unless the change
        // says enabled: true, so that is sent even when it is already on.
        const pausesUnlessOn = "prompt" in fields || "cron" in fields || "target" in fields;
        const enabled =
          requested === undefined ||
          (requested === existing.enabled && !(requested && pausesUnlessOn))
            ? undefined
            : requested;
        if (enabled === true) yield* coordinator.requireUserTurn;
        if (Object.keys(fields).length === 0 && enabled === undefined) {
          return {
            id: existing.id,
            enabled: existing.enabled,
            nextRun: yield* nextRunOf(existing),
          };
        }
        yield* dispatchChange(coordinator, {
          kind: "upsert",
          id: existing.id,
          ...fields,
          ...(enabled === undefined ? {} : { enabled }),
        });
        const { schedule: updated } = yield* requireSchedule(coordinator, existing.id);
        return { id: updated.id, enabled: updated.enabled, nextRun: yield* nextRunOf(updated) };
      }),

    delete: (coordinator: ScheduleScope, input: ScheduleDeleteInput) =>
      Effect.gen(function* () {
        const { schedule: existing } = yield* requireSchedule(coordinator, input.id);
        yield* dispatchChange(coordinator, { kind: "delete", id: existing.id });
        return { id: existing.id, deleted: true as const };
      }),
  };
});

/**
 * The tools: the coordinator manages its own Project's schedules; the user's
 * Assistant also any Project in its reach, named by `projectId`, here or on a
 * linked server (the schedule lives and fires on the server that runs it).
 */
export const makeScheduleHandlers = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settings = yield* ServerSettings.ServerSettingsService;
  const core = yield* makeScheduleCore;
  const reach = yield* Reach;

  type Resolved =
    | { readonly kind: "local"; readonly scope: ScheduleScope }
    | {
        readonly kind: "remote";
        readonly machine: ReachMachine;
        readonly callerRef: { readonly threadId: string; readonly threadTitle: string };
        readonly userTurn: Effect.Effect<boolean>;
      };

  /** Checked live, so a replaced coordinator, or one whose Project was archived, is refused. */
  const requireScope = Effect.fn("ScheduleTools.requireScope")(function* (
    requested: string | undefined,
  ) {
    const invocation = yield* McpInvocationContext.requireMcpCapability("agents");
    const caller = yield* snapshots
      .getThreadShellById(invocation.threadId)
      .pipe(Effect.mapError(readFailed));
    if (Option.isNone(caller)) return yield* new SchedulesCoordinatorOnlyError();
    const project = yield* snapshots
      .getProjectShellById(caller.value.projectId)
      .pipe(Effect.mapError(readFailed));
    if (Option.isNone(project)) return yield* new SchedulesCoordinatorOnlyError();
    const userTurn = core.requireUserTurn(caller.value);
    const own: Resolved = {
      kind: "local",
      scope: { project: project.value, actorThreadId: caller.value.id, requireUserTurn: userTurn },
    };
    if (isAssistantChannel(project.value, caller.value) && requested !== undefined) {
      if (requested === project.value.id) return own;
      const notInReach = new AgentToolFailedError({
        detail: `'${requested}' is not a Project in your reach. Use a projectId from cp_assistant_overview.`,
      });
      const { assistant } = yield* settings.getSettings.pipe(Effect.mapError(readFailed));
      if (!isProjectInAssistantReach(assistant, requested)) return yield* notInReach;
      const target = yield* snapshots
        .getProjectShellById(ProjectId.make(requested))
        .pipe(Effect.mapError(readFailed));
      if (Option.isSome(target)) {
        const marker = target.value.assistant;
        if (marker == null || marker.scope === "global" || marker.archivedAt != null) {
          return yield* notInReach;
        }
        return {
          kind: "local",
          scope: {
            project: target.value,
            actorThreadId: caller.value.id,
            requireUserTurn: userTurn,
          },
        } satisfies Resolved;
      }
      const callerRef = { threadId: caller.value.id, threadTitle: caller.value.title };
      const machine = yield* reach.locateProject(requested, callerRef);
      if (Option.isNone(machine)) return yield* notInReach;
      return {
        kind: "remote",
        machine: machine.value.machine,
        callerRef,
        // Checked here, where the Assistant's turn is: the linked server cannot see it.
        userTurn: userTurn.pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      } satisfies Resolved;
    }
    if (agentManagerRole(project.value, caller.value) !== "coordinator") {
      return yield* new SchedulesCoordinatorOnlyError();
    }
    if (requested !== undefined && requested !== project.value.id) {
      return yield* new AgentToolFailedError({
        detail: "Only the user's Assistant can manage another Project's schedules. Omit projectId.",
      });
    }
    return own;
  });

  const forward = <A, I>(
    resolved: Extract<Resolved, { kind: "remote" }>,
    op: "schedule.list" | "schedule.create" | "schedule.update" | "schedule.delete",
    projectId: string,
    input: unknown,
    result: Schema.Codec<A, I>,
  ) =>
    Effect.gen(function* () {
      const userTurn = op === "schedule.list" ? false : yield* resolved.userTurn;
      return yield* reach
        .call(resolved.machine, op, { projectId, input, userTurn }, resolved.callerRef, result)
        .pipe(Effect.mapError((error) => new AgentToolFailedError({ detail: error.detail })));
    });

  /** Drops `projectId` before the core sees the input. */
  const withoutProject = <T extends { readonly projectId?: string | undefined }>(input: T) => {
    const { projectId: _projectId, ...rest } = input;
    return rest;
  };

  return {
    cp_schedule_list: (input) =>
      Effect.gen(function* () {
        const resolved = yield* requireScope(input?.projectId);
        if (resolved.kind === "remote") {
          return yield* forward(
            resolved,
            "schedule.list",
            input!.projectId!,
            {},
            ScheduleListResult,
          );
        }
        return yield* core.list(resolved.scope);
      }),
    cp_schedule_create: (input) =>
      Effect.gen(function* () {
        const resolved = yield* requireScope(input.projectId);
        if (resolved.kind === "remote") {
          return yield* forward(
            resolved,
            "schedule.create",
            input.projectId!,
            withoutProject(input),
            ScheduleCreateResult,
          );
        }
        return yield* core.create(resolved.scope, withoutProject(input));
      }),
    cp_schedule_update: (input) =>
      Effect.gen(function* () {
        const resolved = yield* requireScope(input.projectId);
        if (resolved.kind === "remote") {
          return yield* forward(
            resolved,
            "schedule.update",
            input.projectId!,
            withoutProject(input),
            ScheduleUpdateResult,
          );
        }
        return yield* core.update(resolved.scope, withoutProject(input));
      }),
    cp_schedule_delete: (input) =>
      Effect.gen(function* () {
        const resolved = yield* requireScope(input.projectId);
        if (resolved.kind === "remote") {
          return yield* forward(
            resolved,
            "schedule.delete",
            input.projectId!,
            withoutProject(input),
            ScheduleDeleteResult,
          );
        }
        return yield* core.delete(resolved.scope, withoutProject(input));
      }),
  } satisfies ScheduleHandlers;
});
