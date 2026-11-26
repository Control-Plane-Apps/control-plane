/**
 * Handles a Status decision's deadline once it passes without a reply.
 * Fork-owned. (A user's `Re:` reply is recorded by the decider with the
 * message itself, so it always lands before any deadline can act.)
 *
 * By default a passed deadline only reminds the coordinator: silence is not
 * approval, so the question stays open. Only when the user opted in for that
 * exact decision version is the recommendation sent as their answer. Each
 * version is handled at most once: the message id derives from the version
 * and the decider refuses a duplicate, and `project.status.deadline` is
 * refused once recorded, so a restart between the two steps sends nothing
 * new. The append is delivered like a schedule run: it starts a turn once the
 * coordinator is idle.
 *
 * The same sweep watches for stalled rows: a workstream that says `working`
 * while none of its agents has run for the server's `statusStallMinutes` (or,
 * with no agents linked, has not been updated for that long). Its coordinator
 * gets one nudge per stall, keyed by the row and when the stall began, so a
 * restart or a repeat sweep never sends it twice. Any write to the row, or an
 * agent running again, starts a new clock.
 *
 * @module StatusDeadlineReactor
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { withProjectWriter } from "../reach/projectMoveFence.ts";
import {
  CommandId,
  isAutoAcceptArmed,
  MessageId,
  type OrchestrationEvent,
  type ProjectAssistant,
  type ProjectId,
  type ProjectStatus,
  type ProjectStatusDeadlineOutcome,
  type StatusAgentShell,
  type StatusStall,
  statusReminderMessageId,
  statusReplyText,
  statusStallMessageId,
  statusStallMinutesOf,
  statusStallOf,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  isOrchestrationCommandRejection,
  OrchestrationCommandIdConflictError,
  OrchestrationCommandPreviouslyRejectedError,
} from "./Errors.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";

const isPreviouslyRejected = Schema.is(OrchestrationCommandPreviouslyRejectedError);
const isIdConflict = Schema.is(OrchestrationCommandIdConflictError);
const isSettledReplay = (error: unknown) => isPreviouslyRejected(error) || isIdConflict(error);

export class StatusDeadlineReactor extends Context.Service<
  StatusDeadlineReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Sweeps now and waits for it. Tests use this instead of the clock. */
    readonly sweep: Effect.Effect<void>;
    /** Waits for queued sweeps. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/StatusDeadlineReactor") {}

export interface DueDeadline {
  readonly receiptProjectId: string;
  readonly projectId: ProjectId;
  readonly coordinatorThreadId: ProjectAssistant["coordinatorThreadId"];
  readonly status: ProjectStatus;
}

/** Decisions owed a reminder at `nowMs`, and the next deadline after it (or null). */
export function dueDeadlines(
  projects: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly assistant?: ProjectAssistant | null | undefined;
    readonly deletedAt: string | null;
  }>,
  nowMs: number,
): { readonly due: DueDeadline[]; readonly nextAtMs: number | null } {
  const due: DueDeadline[] = [];
  let nextAtMs: number | null = null;
  for (const project of projects) {
    const assistant = project.assistant;
    // An archived Project waits; unarchiving it brings the reminder back.
    if (project.deletedAt !== null || assistant == null || assistant.archivedAt != null) continue;
    for (const status of assistant.statuses ?? []) {
      const decision = status.decision;
      if (
        decision?.deadline === undefined ||
        decision.deadlineHandled !== undefined ||
        decision.answeredAt !== undefined
      ) {
        continue;
      }
      const at = Date.parse(decision.deadline);
      if (Number.isNaN(at)) continue;
      if (at <= nowMs) {
        due.push({
          projectId: project.projectId,
          receiptProjectId: assistant.scheduleProjectId ?? project.projectId,
          coordinatorThreadId: assistant.coordinatorThreadId,
          status,
        });
      } else if (nextAtMs === null || at < nextAtMs) {
        nextAtMs = at;
      }
    }
  }
  return { due, nextAtMs };
}

/** Decisions whose deadline was handled while they are still open, with how. */
function handledDeadlines(rows: Parameters<typeof dueDeadlines>[0]) {
  return rows.flatMap((project) => {
    const assistant = project.assistant;
    if (project.deletedAt !== null || assistant == null || assistant.archivedAt != null) return [];
    return (assistant.statuses ?? []).flatMap((status) => {
      const handled = status.decision?.deadlineHandled;
      return handled === undefined
        ? []
        : [
            {
              projectId: project.projectId,
              receiptProjectId: assistant.scheduleProjectId ?? project.projectId,
              coordinatorThreadId: assistant.coordinatorThreadId,
              status,
              outcome: handled.outcome,
              at: handled.at,
            },
          ];
    });
  });
}

/** What the coordinator receives when a deadline passes, by outcome. */
export function statusDeadlineText(
  status: ProjectStatus,
  outcome: ProjectStatusDeadlineOutcome,
): string {
  const decision = status.decision;
  if (decision === undefined) return "";
  if (outcome === "accepted") {
    return statusReplyText(
      status.title,
      [
        `Go with your recommendation: ${decision.recommendation}`,
        "",
        `(Sent at the deadline because the user opted in to this recommendation for "${decision.question}". It covers this recommendation only, within your normal permissions: anything that needs the user's approval still needs it. Act on it, then clear the question with cp_status_set.)`,
      ].join("\n"),
      { statusId: status.id, openedAt: decision.openedAt },
    );
  }
  return [
    `The deadline passed on your question for "${status.title}", and the user has not replied.`,
    "",
    `Question: ${decision.question}`,
    `Your recommendation: ${decision.recommendation}`,
    "",
    "This is a reminder, not an answer. Silence never authorizes acting for the user: do not take the action they were asked to decide. Keep waiting or ask again, and update the workstream with cp_status_set, with a new deadline if you still need an answer.",
  ].join("\n");
}

export interface StalledStatus {
  readonly receiptProjectId: string;
  readonly projectId: ProjectId;
  readonly coordinatorThreadId: ProjectAssistant["coordinatorThreadId"];
  readonly status: ProjectStatus;
  readonly stall: StatusStall;
}

/** Live Projects' rows that can stall, for the sweep to read their agents. */
function stallCandidates(rows: Parameters<typeof dueDeadlines>[0]) {
  return rows.flatMap((project) => {
    const assistant = project.assistant;
    if (project.deletedAt !== null || assistant == null || assistant.archivedAt != null) return [];
    return (assistant.statuses ?? [])
      .filter(
        (status) =>
          status.dismissedAt === undefined &&
          (status.state === "working" ||
            (status.state === "queued" && (status.agents?.length ?? 0) > 0)),
      )
      .map((status) => ({
        projectId: project.projectId,
        receiptProjectId: assistant.scheduleProjectId ?? project.projectId,
        coordinatorThreadId: assistant.coordinatorThreadId,
        status,
      }));
  });
}

/**
 * Rows stalled at `nowMs`, and when the next one could stall (or null). A row
 * with a live agent has no predictable time, so it asks for a recheck after
 * `stallMinutes`; agent events also mark the sweep dirty.
 */
export function stalledStatuses(
  rows: Parameters<typeof dueDeadlines>[0],
  shells: ReadonlyMap<string, StatusAgentShell | null>,
  nowMs: number,
  stallMinutes: number,
): { readonly stalled: StalledStatus[]; readonly nextAtMs: number | null } {
  const stalled: StalledStatus[] = [];
  let nextAtMs: number | null = null;
  if (stallMinutes <= 0) return { stalled, nextAtMs };
  const stallMs = stallMinutes * 60_000;
  const later = (at: number) => {
    if (nextAtMs === null || at < nextAtMs) nextAtMs = at;
  };
  for (const entry of stallCandidates(rows)) {
    const agents = (entry.status.agents ?? []).map((id) => shells.get(id) ?? null);
    const stall = statusStallOf(entry.status, agents, nowMs, stallMinutes);
    if (stall !== null) {
      stalled.push({ ...entry, stall });
      continue;
    }
    // Not yet: find when it would be, assuming nothing changes.
    const probe = statusStallOf(entry.status, agents, Number.MAX_SAFE_INTEGER, stallMinutes);
    later(probe === null ? nowMs + stallMs : probe.sinceMs + stallMs);
  }
  return { stalled, nextAtMs };
}

/** The one nudge a stalled row's coordinator receives. */
export function statusStallText(status: ProjectStatus, stall: StatusStall): string {
  const ref = `"${status.title}" [status:${status.id}]`;
  const what =
    stall.kind === "agents-stopped"
      ? `still says ${status.state}, but none of its agents is running. ${stall.reason}.`
      : `still says ${status.state}, but no agent is linked to it. ${stall.reason}.`;
  return [
    `Status check: ${ref} ${what} The user sees it marked Stalled.`,
    "",
    "Update the row with cp_status_set now: mark it done, queued or needs-you, link the agent that is on it, or start one. Keep a row working only while an agent is actually working on it.",
    "",
    "This is the only reminder for this stall. Any update to the row clears it.",
  ].join("\n");
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectionProjectRepository;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settings = yield* ServerSettings.ServerSettingsService;
  // Nudges sent (or settled) this run, so a stall is dispatched once; the
  // message id dedupes across restarts.
  const nudged = new Set<string>();
  // Earliest pending deadline from the last sweep. The minute tick reads the
  // projects table only once it has passed or a status write invalidated it.
  let nextAtMs: number | null = null;
  let dirty = true;
  let lastPaused = new Set<string>();

  const logRejected =
    (step: string, entry: { readonly projectId: ProjectId; readonly statusId: string }) =>
    (error: { readonly message: string }) =>
      Effect.logDebug(`status ${step} skipped`, { ...entry, detail: error.message });

  /** Idempotent: the message id is the command id, so a repeat is deduplicated by its receipt. */
  const sendDeadlineMessage = (
    entry: DueDeadline,
    outcome: ProjectStatusDeadlineOutcome,
    createdAt: string,
  ) => {
    const decision = entry.status.decision;
    if (decision === undefined) return Effect.void;
    const messageId = statusReminderMessageId(
      entry.receiptProjectId,
      entry.status.id,
      decision.openedAt,
    );
    return engine
      .dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make(messageId),
        threadId: entry.coordinatorThreadId,
        message: {
          messageId: MessageId.make(messageId),
          text: statusDeadlineText(entry.status, outcome),
          attachments: [],
          source: { kind: "agent", threadTitle: "Status" },
        },
        createdAt,
      })
      .pipe(
        Effect.asVoid,
        Effect.catchIf(
          isOrchestrationCommandRejection,
          logRejected("deadline message", {
            projectId: entry.projectId,
            statusId: entry.status.id,
          }),
        ),
      );
  };

  const handleDeadline = Effect.fn("StatusDeadlineReactor.handleDeadline")(function* (
    entry: DueDeadline,
  ) {
    const decision = entry.status.decision;
    if (decision === undefined) return;
    const outcome: ProjectStatusDeadlineOutcome = isAutoAcceptArmed(decision)
      ? "accepted"
      : "reminded";
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const ids = { projectId: entry.projectId, statusId: entry.status.id };
    const messageId = statusReminderMessageId(
      entry.receiptProjectId,
      entry.status.id,
      decision.openedAt,
    );
    // Record first: the decider re-checks the opt-in against the stored
    // version and turns a withdrawn one into a reminder, so the message goes
    // out for the outcome it stored, never the one this sweep guessed.
    const recorded = yield* engine
      .dispatch({
        type: "project.status.deadline",
        commandId: CommandId.make(`${messageId}:handled:${outcome}`),
        projectId: entry.projectId,
        statusId: entry.status.id,
        openedAt: decision.openedAt,
        outcome,
        createdAt,
      })
      .pipe(
        Effect.as(true),
        Effect.catchIf(isOrchestrationCommandRejection, (error) =>
          logRejected("deadline", ids)(error).pipe(Effect.as(false)),
        ),
      );
    if (!recorded) return;
    const stored = Option.getOrUndefined(
      yield* projects.getById({ projectId: entry.projectId }),
    )?.assistant?.statuses?.find((status) => status.id === entry.status.id);
    const handled = stored?.decision?.deadlineHandled;
    if (stored === undefined || handled === undefined) return;
    yield* sendDeadlineMessage({ ...entry, status: stored }, handled.outcome, handled.at);
  });

  /** One decision's failure never holds up another's. */
  const isolated = <E, R>(entry: DueDeadline, effect: Effect.Effect<void, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        const ids = { projectId: entry.projectId, statusId: entry.status.id };
        const error = Option.getOrUndefined(Cause.findErrorOption(cause));
        // A replayed id is settled for good (sent before, or its coordinator
        // was replaced); anything else is retried on the next tick.
        return isSettledReplay(error)
          ? Effect.logDebug("status deadline step already settled", ids)
          : Effect.sync(() => {
              dirty = true;
            }).pipe(
              Effect.andThen(
                Effect.logWarning("status deadline step failed", {
                  ...ids,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
      }),
    );

  const sendStallNudge = (entry: StalledStatus, createdAt: string) => {
    const messageId = statusStallMessageId(
      entry.receiptProjectId,
      entry.status.id,
      entry.stall.sinceMs,
    );
    if (nudged.has(messageId)) return Effect.void;
    return engine
      .dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make(messageId),
        threadId: entry.coordinatorThreadId,
        message: {
          messageId: MessageId.make(messageId),
          text: statusStallText(entry.status, entry.stall),
          attachments: [],
          source: { kind: "agent", threadTitle: "Status" },
        },
        createdAt,
      })
      .pipe(
        Effect.tap(() => Effect.sync(() => nudged.add(messageId))),
        Effect.asVoid,
        Effect.catchIf(isOrchestrationCommandRejection, (error) =>
          Effect.sync(() => nudged.add(messageId)).pipe(
            Effect.andThen(
              logRejected("stall nudge", {
                projectId: entry.projectId,
                statusId: entry.status.id,
              })(error),
            ),
          ),
        ),
      );
  };

  /** Each linked agent's shell, null for one that is gone. */
  const agentShells = Effect.fn("StatusDeadlineReactor.agentShells")(function* (
    rows: Parameters<typeof dueDeadlines>[0],
  ) {
    const ids = new Set<ThreadId>();
    for (const entry of stallCandidates(rows)) {
      for (const id of entry.status.agents ?? []) ids.add(id);
    }
    const shells = new Map<string, StatusAgentShell | null>();
    yield* Effect.forEach(
      ids,
      (id) =>
        snapshots.getThreadShellById(id).pipe(
          Effect.map((shell) => shells.set(id, Option.getOrNull(shell))),
          // An unreadable agent counts as gone for this sweep only.
          Effect.catch(() => Effect.sync(() => shells.set(id, null))),
        ),
      { discard: true },
    );
    return shells;
  });

  const sweepOnce = Effect.fn("StatusDeadlineReactor.sweep")(function* (force: boolean) {
    const nowMs = yield* Clock.currentTimeMillis;
    // Releasing a fence need not emit a Project event. New owners must still
    // discover reminders that became due while the Project was staged.
    const fences = yield* sql<{ project_id: string }>`SELECT project_id FROM project_move_fences`;
    const paused = new Set(fences.map((row) => row.project_id));
    const ownersChanged =
      paused.size !== lastPaused.size || fences.some((row) => !lastPaused.has(row.project_id));
    lastPaused = paused;
    if (!force && !dirty && !ownersChanged && (nextAtMs === null || nextAtMs > nowMs)) return;
    dirty = false;
    const rows = (yield* projects.listAll()).filter((row) => !paused.has(row.projectId));
    // Resend messages for deadlines recorded before a failed send or a crash;
    // their receipts make the ones already sent a no-op.
    yield* Effect.forEach(
      handledDeadlines(rows),
      (entry) => isolated(entry, sendDeadlineMessage(entry, entry.outcome, entry.at)),
      { discard: true },
    );
    const result = dueDeadlines(rows, nowMs);
    yield* Effect.forEach(
      result.due,
      (entry) => isolated(entry, withProjectWriter(sql, entry.projectId, handleDeadline(entry))),
      {
        discard: true,
      },
    );
    const stallMinutes = statusStallMinutesOf((yield* settings.getSettings).statusStallMinutes);
    const stalls = stalledStatuses(rows, yield* agentShells(rows), nowMs, stallMinutes);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* Effect.forEach(
      stalls.stalled,
      (entry) => isolated(entry, sendStallNudge(entry, createdAt)),
      { discard: true },
    );
    nextAtMs =
      result.nextAtMs === null
        ? stalls.nextAtMs
        : stalls.nextAtMs === null
          ? result.nextAtMs
          : Math.min(result.nextAtMs, stalls.nextAtMs);
  });

  const runSweep = (force: boolean) =>
    sweepOnce(force).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("status deadline sweep failed", { cause: Cause.pretty(cause) }).pipe(
              // Retry on the next tick rather than waiting for the next write.
              Effect.andThen(Effect.sync(() => (dirty = true))),
            ),
      ),
    );

  const worker = yield* makeDrainableWorker((force: boolean) => runSweep(force));

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "project.status-updated":
      case "project.meta-updated":
      case "project.deleted":
        dirty = true;
        return worker.enqueue(false);
      // An agent starting or stopping moves a stall clock; the minute tick
      // picks it up, so frequent turn events never sweep on their own.
      case "thread.session-set":
      case "thread.settled":
      case "thread.archived":
      case "thread.deleted":
        dirty = true;
        return Effect.void;
      default:
        return Effect.void;
    }
  };

  const start: StatusDeadlineReactor["Service"]["start"] = Effect.fn("StatusDeadlineReactor.start")(
    function* () {
      const events = yield* engine.subscribeDomainEvents;
      yield* forkParked(
        worker.enqueue(false).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
      );
      yield* forkParked(Stream.runForEach(events, processEvent));
    },
  );

  return {
    start,
    sweep: Effect.andThen(worker.enqueue(true), worker.drain),
    drain: worker.drain,
  } satisfies StatusDeadlineReactor["Service"];
});

export const layer = Layer.effect(StatusDeadlineReactor, make);
