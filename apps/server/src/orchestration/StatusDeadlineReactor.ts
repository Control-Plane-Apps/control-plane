/**
 * Reminds a coordinator once when a Status decision's deadline passes
 * without the question being cleared. Fork-owned.
 *
 * The reminder is a message, never an action: silence is not approval, so
 * the coordinator is told to keep waiting or ask again. Each decision version
 * (`openedAt`) is reminded at most once. The message id is derived from the
 * version and the decider refuses a duplicate id, and `project.status.remind`
 * is refused once recorded, so a restart between the two steps resends
 * nothing. The append is delivered like a schedule run: it starts a turn once
 * the coordinator is idle.
 *
 * @module StatusDeadlineReactor
 */
import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type ProjectAssistant,
  type ProjectId,
  type ProjectStatus,
  statusReminderMessageId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { forkParked } from "../serverActivation.ts";
import { isOrchestrationCommandRejection } from "./Errors.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";

export class StatusDeadlineReactor extends Context.Service<
  StatusDeadlineReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Sweeps now and waits for it. Tests use this instead of the clock. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration/StatusDeadlineReactor") {}

export interface DueReminder {
  readonly projectId: ProjectId;
  readonly coordinatorThreadId: ProjectAssistant["coordinatorThreadId"];
  readonly status: ProjectStatus;
}

/** Decisions owed a reminder at `nowMs`, and the next deadline after it (or null). */
export function dueReminders(
  projects: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly assistant?: ProjectAssistant | null | undefined;
    readonly deletedAt: string | null;
  }>,
  nowMs: number,
): { readonly due: DueReminder[]; readonly nextAtMs: number | null } {
  const due: DueReminder[] = [];
  let nextAtMs: number | null = null;
  for (const project of projects) {
    const assistant = project.assistant;
    // An archived Project waits; unarchiving it brings the reminder back.
    if (project.deletedAt !== null || assistant == null || assistant.archivedAt != null) continue;
    for (const status of assistant.statuses ?? []) {
      const decision = status.decision;
      if (decision?.deadline === undefined || decision.remindedAt !== undefined) continue;
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

export function statusReminderText(status: ProjectStatus): string {
  const decision = status.decision;
  if (decision === undefined) return "";
  return [
    `The deadline passed on your question for "${status.title}", and the user has not replied.`,
    "",
    `Question: ${decision.question}`,
    `Your recommendation: ${decision.recommendation}`,
    ...(decision.ifNoReply !== undefined
      ? [`You said without a reply: ${decision.ifNoReply}`]
      : []),
    "",
    "This is a reminder, not an answer. Silence never authorizes acting for the user: do not take the action they were asked to decide. Keep waiting or ask again, and update the workstream with cp_status_set, with a new deadline if you still need an answer.",
  ].join("\n");
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projects = yield* ProjectionProjectRepository;
  // Earliest pending deadline from the last sweep. The minute tick reads the
  // projects table only once it has passed or a status write invalidated it.
  let nextAtMs: number | null = null;
  let dirty = true;

  const remind = Effect.fn("StatusDeadlineReactor.remind")(function* (entry: DueReminder) {
    const decision = entry.status.decision;
    if (decision === undefined) return;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const messageId = statusReminderMessageId(entry.projectId, entry.status.id, decision.openedAt);
    const rejected = (step: string) => (error: { readonly message: string }) =>
      Effect.logDebug(`status reminder ${step} skipped`, {
        projectId: entry.projectId,
        statusId: entry.status.id,
        detail: error.message,
      });
    // A duplicate id means an earlier sweep sent it; recording it is still owed.
    yield* engine
      .dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make(messageId),
        threadId: entry.coordinatorThreadId,
        message: {
          messageId: MessageId.make(messageId),
          text: statusReminderText(entry.status),
          attachments: [],
          source: { kind: "agent", threadTitle: "Status" },
        },
        createdAt,
      })
      .pipe(Effect.catchIf(isOrchestrationCommandRejection, rejected("message")));
    yield* engine
      .dispatch({
        type: "project.status.remind",
        commandId: CommandId.make(`${messageId}:recorded`),
        projectId: entry.projectId,
        statusId: entry.status.id,
        openedAt: decision.openedAt,
        createdAt,
      })
      .pipe(Effect.catchIf(isOrchestrationCommandRejection, rejected("record")));
  });

  const sweepOnce = Effect.fn("StatusDeadlineReactor.sweep")(function* (force: boolean) {
    const nowMs = yield* Clock.currentTimeMillis;
    if (!force && !dirty && (nextAtMs === null || nextAtMs > nowMs)) return;
    dirty = false;
    const rows = yield* projects.listAll();
    const result = dueReminders(rows, nowMs);
    nextAtMs = result.nextAtMs;
    yield* Effect.forEach(result.due, remind, { discard: true });
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
  } satisfies StatusDeadlineReactor["Service"];
});

export const layer = Layer.effect(StatusDeadlineReactor, make);
