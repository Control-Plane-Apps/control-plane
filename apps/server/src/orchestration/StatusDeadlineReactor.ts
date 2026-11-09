/**
 * Handles a Status decision's deadline once it passes without a reply, and
 * notices when the user replies to a workstream. Fork-owned.
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
 * @module StatusDeadlineReactor
 */
import {
  CommandId,
  isAutoAcceptArmed,
  MessageId,
  type OrchestrationEvent,
  parseStatusReply,
  type ProjectAssistant,
  type ProjectId,
  type ProjectStatus,
  type ProjectStatusDeadlineOutcome,
  statusReminderMessageId,
  statusReplyText,
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
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { forkParked } from "../serverActivation.ts";
import { isOrchestrationCommandRejection } from "./Errors.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

export class StatusDeadlineReactor extends Context.Service<
  StatusDeadlineReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Sweeps now and waits for it. Tests use this instead of the clock. */
    readonly sweep: Effect.Effect<void>;
    /** Waits for queued reply checks and sweeps. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/StatusDeadlineReactor") {}

export interface DueDeadline {
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
        `(Sent at the deadline because the user opted in to this recommendation for "${decision.question}". Act on it, then clear the question with cp_status_set.)`,
      ].join("\n"),
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

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projects = yield* ProjectionProjectRepository;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  // Earliest pending deadline from the last sweep. The minute tick reads the
  // projects table only once it has passed or a status write invalidated it.
  let nextAtMs: number | null = null;
  let dirty = true;
  // The first sweep resends messages for deadlines recorded just before a
  // crash; their receipts make the ones already sent a no-op.
  let recovered = false;

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
    const messageId = statusReminderMessageId(entry.projectId, entry.status.id, decision.openedAt);
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
    const messageId = statusReminderMessageId(entry.projectId, entry.status.id, decision.openedAt);
    // Record first: the decider re-checks the opt-in against the stored
    // version, so a decision changed since this sweep read it sends nothing.
    const recorded = yield* engine
      .dispatch({
        type: "project.status.deadline",
        commandId: CommandId.make(`${messageId}:handled`),
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
    yield* sendDeadlineMessage(entry, outcome, createdAt);
  });

  /** A `Re: <title>` message from the user in a coordinator thread answers that workstream. */
  const markAnswered = Effect.fn("StatusDeadlineReactor.markAnswered")(function* (
    threadId: ThreadId,
    text: string,
  ) {
    const reply = parseStatusReply(text);
    if (reply === null) return;
    const thread = yield* snapshots.getThreadShellById(threadId);
    if (Option.isNone(thread)) return;
    const project = Option.getOrUndefined(
      yield* projects.getById({ projectId: thread.value.projectId }),
    );
    const assistant = project?.assistant;
    if (assistant == null || assistant.coordinatorThreadId !== threadId) return;
    const status = assistant.statuses?.find((entry) => entry.title === reply.title);
    const decision = status?.decision;
    if (status === undefined || decision === undefined || decision.answeredAt !== undefined) return;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine
      .dispatch({
        type: "project.status.answered",
        commandId: CommandId.make(
          `${statusReminderMessageId(thread.value.projectId, status.id, decision.openedAt)}:answered`,
        ),
        projectId: thread.value.projectId,
        statusId: status.id,
        openedAt: decision.openedAt,
        createdAt,
      })
      .pipe(
        Effect.catchIf(
          isOrchestrationCommandRejection,
          logRejected("answered", { projectId: thread.value.projectId, statusId: status.id }),
        ),
      );
  });

  const sweepOnce = Effect.fn("StatusDeadlineReactor.sweep")(function* (force: boolean) {
    const nowMs = yield* Clock.currentTimeMillis;
    if (!force && !dirty && (nextAtMs === null || nextAtMs > nowMs)) return;
    dirty = false;
    const rows = yield* projects.listAll();
    if (!recovered) {
      recovered = true;
      yield* Effect.forEach(handledDeadlines(rows), (entry) =>
        sendDeadlineMessage(entry, entry.outcome, entry.at),
      );
    }
    const result = dueDeadlines(rows, nowMs);
    nextAtMs = result.nextAtMs;
    yield* Effect.forEach(result.due, handleDeadline, { discard: true });
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
  const replies = yield* makeDrainableWorker(
    (reply: { readonly threadId: ThreadId; readonly text: string }) =>
      markAnswered(reply.threadId, reply.text).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("status reply check failed", { cause: Cause.pretty(cause) }),
        ),
      ),
  );

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "thread.message-sent":
        // Cheap prefilter: only the user's own `Re: ` messages can answer a workstream.
        return event.payload.role === "user" &&
          event.payload.source === undefined &&
          event.payload.text.startsWith("Re: ")
          ? replies.enqueue({ threadId: event.payload.threadId, text: event.payload.text })
          : Effect.void;
      case "project.status-updated":
      case "project.meta-updated":
      case "project.deleted":
        dirty = true;
        return worker.enqueue(false);
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
    drain: Effect.andThen(replies.drain, worker.drain),
  } satisfies StatusDeadlineReactor["Service"];
});

export const layer = Layer.effect(StatusDeadlineReactor, make);
