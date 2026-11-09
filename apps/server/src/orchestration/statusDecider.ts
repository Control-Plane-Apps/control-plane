/**
 * Project Status board invariants for the decider. Fork-owned and pure, so
 * each decider.ts hunk stays a single call.
 *
 * Only the coordinator writes, one record per command, so a write built from
 * a stale read never touches another workstream. Every write stamps
 * `updatedAt`, which is what the UI ages and marks stale. A decision's
 * `openedAt` restamps when its question, recommendation or deadline changes,
 * which drops the user's opt-in, and its deadline is handled at most once per
 * version. Only the user's own client command arms auto-accept.
 */
import {
  PROJECT_STATUS_AGENTS_MAX,
  PROJECT_STATUS_LIMIT,
  PROJECT_STATUS_LINE_MAX,
  PROJECT_STATUS_TITLE_MAX,
  agentManagerRole,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ProjectAssistant,
  type ProjectStatus,
  type ProjectStatusDecision,
  isAutoAcceptArmed,
  parseStatusReply,
  type ThreadId,
} from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { withEventBase, type PlannedOrchestrationEvent } from "./eventBase.ts";

type StatusSetCommand = Extract<OrchestrationCommand, { type: "project.status.set" }>;
type StatusDeadlineCommand = Extract<OrchestrationCommand, { type: "project.status.deadline" }>;
type StatusAutomateCommand = Extract<OrchestrationCommand, { type: "project.status.automate" }>;
type UpsertChange = Extract<StatusSetCommand["change"], { kind: "upsert" }>;

function invariant(commandType: string, detail: string) {
  return new OrchestrationCommandInvariantError({ commandType, detail });
}

function tooLong(label: string, value: string | undefined, max: number): string | null {
  return value !== undefined && value.length > max
    ? `${label} is at most ${max} characters.`
    : null;
}

/** Empty or whitespace-only clears an optional text field. */
function optionalText(value: string | undefined, stored: string | undefined): string | undefined {
  if (value === undefined) return stored;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function nextDecision(
  change: UpsertChange,
  stored: ProjectStatusDecision | undefined,
  now: string,
): { readonly decision: ProjectStatusDecision | undefined } | string {
  const touchesDecision =
    change.question !== undefined ||
    change.recommendation !== undefined ||
    change.deadline !== undefined;
  if (change.clearDecision === true) {
    return touchesDecision
      ? "Pass clearDecision alone, or a new question without clearDecision."
      : { decision: undefined };
  }
  if (!touchesDecision) return { decision: stored };

  const question = change.question ?? stored?.question;
  const recommendation = change.recommendation ?? stored?.recommendation;
  if (question === undefined || recommendation === undefined) {
    return "A decision needs both a question and your recommendation.";
  }
  const deadline =
    change.deadline === undefined ? stored?.deadline : (change.deadline ?? undefined);
  if (deadline !== undefined) {
    const at = Date.parse(deadline);
    if (Number.isNaN(at)) return `Deadline '${deadline}' is not an ISO date-time.`;
    if (deadline !== stored?.deadline && at <= Date.parse(now)) {
      return "The deadline must be in the future.";
    }
  }
  // The user opted in to a specific recommendation by a specific time; any
  // change makes it a new decision they have not seen.
  if (
    stored !== undefined &&
    stored.question === question &&
    stored.recommendation === recommendation &&
    stored.deadline === deadline
  ) {
    return { decision: stored };
  }
  // A new version never inherits a deadline that already passed: that one
  // was handled, and the next needs a deadline of its own.
  const liveDeadline =
    deadline !== undefined && Date.parse(deadline) <= Date.parse(now) ? undefined : deadline;
  return {
    decision: {
      question,
      recommendation,
      ...(liveDeadline !== undefined ? { deadline: liveDeadline } : {}),
      openedAt: now,
    },
  };
}

/** The record one upsert produces, or why it is refused. */
export function applyStatusUpsert(input: {
  readonly readModel: OrchestrationReadModel;
  readonly projectId: string;
  readonly statuses: ReadonlyArray<ProjectStatus>;
  readonly change: UpsertChange;
  readonly now: string;
}): ProjectStatus | string {
  const { change, statuses, now } = input;
  const stored = statuses.find((status) => status.id === change.id);
  if (stored === undefined && statuses.length >= PROJECT_STATUS_LIMIT) {
    return `A Project has at most ${PROJECT_STATUS_LIMIT} workstreams. Remove finished ones first.`;
  }
  const title = change.title ?? stored?.title;
  const summary = change.summary ?? stored?.summary;
  if (title === undefined || summary === undefined) {
    return "A new workstream needs a title and a summary.";
  }
  const lengthError =
    tooLong("A title", title, PROJECT_STATUS_TITLE_MAX) ??
    tooLong("The summary", summary, PROJECT_STATUS_LINE_MAX) ??
    tooLong("The detail", change.detail?.trim(), PROJECT_STATUS_LINE_MAX) ??
    tooLong("The question", change.question, PROJECT_STATUS_LINE_MAX) ??
    tooLong("The recommendation", change.recommendation, PROJECT_STATUS_LINE_MAX);
  if (lengthError !== null) return lengthError;
  if (title.includes("\n")) return "A title is one line.";
  const folded = title.toLowerCase();
  if (statuses.some((status) => status.id !== change.id && status.title.toLowerCase() === folded)) {
    return `Another workstream is already titled '${title}'.`;
  }

  let agents = stored?.agents;
  if (change.agents !== undefined) {
    const unique = [...new Set(change.agents)];
    if (unique.length > PROJECT_STATUS_AGENTS_MAX) {
      return `A workstream lists at most ${PROJECT_STATUS_AGENTS_MAX} agents.`;
    }
    for (const threadId of unique) {
      const thread = input.readModel.threads.find((entry) => entry.id === threadId);
      if (
        thread === undefined ||
        thread.projectId !== input.projectId ||
        thread.deletedAt !== null
      ) {
        return `'${threadId}' is not a thread in this Project.`;
      }
    }
    agents = unique.length > 0 ? (unique as ThreadId[]) : undefined;
  }

  const decided = nextDecision(change, stored?.decision, now);
  if (typeof decided === "string") return decided;
  const { decision } = decided;
  const requested = change.state ?? stored?.state ?? "working";
  // A question always waits on the user; clearing one moves the row on unless told otherwise.
  const state =
    decision !== undefined
      ? "needs-you"
      : change.state === undefined && stored?.decision !== undefined && requested === "needs-you"
        ? "working"
        : requested;
  const detail = optionalText(change.detail, stored?.detail);
  return {
    id: change.id,
    title,
    state,
    summary,
    ...(detail !== undefined ? { detail } : {}),
    ...(agents !== undefined ? { agents } : {}),
    ...(decision !== undefined ? { decision } : {}),
    updatedAt: now,
  };
}

function statusEvent(
  command: StatusSetCommand | StatusDeadlineCommand | StatusAutomateCommand,
  statusId: string,
  status: ProjectStatus | null,
) {
  return Effect.map(
    withEventBase({
      aggregateKind: "project",
      aggregateId: command.projectId,
      occurredAt: command.createdAt,
      commandId: command.commandId,
    }),
    (base): PlannedOrchestrationEvent => ({
      ...base,
      type: "project.status-updated" as const,
      payload: { projectId: command.projectId, statusId, status },
    }),
  );
}

/** The live decision `command` names, at the version it names, or why not. */
function decisionAt(
  readModel: OrchestrationReadModel,
  command: { readonly projectId: string; readonly statusId: string; readonly openedAt: string },
): { readonly status: ProjectStatus; readonly decision: ProjectStatusDecision } | string {
  const project = readModel.projects.find((entry) => entry.id === command.projectId);
  const status =
    project?.deletedAt === null && project.assistant?.archivedAt == null
      ? project.assistant?.statuses?.find((entry) => entry.id === command.statusId)
      : undefined;
  const decision = status?.decision;
  if (status === undefined || decision === undefined) return "That decision is no longer open.";
  if (decision.openedAt !== command.openedAt) {
    return "The coordinator changed this decision since it was read. Review it again.";
  }
  return { status, decision };
}

/** `project.status.set`: one coordinator write. */
export const decideStatusSet = Effect.fn("decideStatusSet")(function* (
  readModel: OrchestrationReadModel,
  command: StatusSetCommand,
): Effect.fn.Return<
  PlannedOrchestrationEvent,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const project = readModel.projects.find((entry) => entry.id === command.projectId);
  if (project === undefined || project.deletedAt !== null || project.assistant == null) {
    return yield* invariant(command.type, `Project '${command.projectId}' has no Status board.`);
  }
  const actor = readModel.threads.find((thread) => thread.id === command.actorThreadId);
  // The status tool checks this too; the decider keeps it true for any caller.
  if (
    actor === undefined ||
    actor.deletedAt !== null ||
    actor.archivedAt !== null ||
    agentManagerRole(project, actor) !== "coordinator"
  ) {
    return yield* invariant(command.type, "Only the Project's coordinator can write Status.");
  }
  const statuses = project.assistant.statuses ?? [];
  const { change } = command;
  if (change.kind === "remove") {
    if (!statuses.some((status) => status.id === change.id)) {
      return yield* invariant(command.type, `There is no workstream '${change.id}'.`);
    }
    return yield* statusEvent(command, change.id, null);
  }
  const next = applyStatusUpsert({
    readModel,
    projectId: command.projectId,
    statuses,
    change,
    now: command.createdAt,
  });
  if (typeof next === "string") return yield* invariant(command.type, next);
  return yield* statusEvent(command, change.id, next);
});

/**
 * `project.status.deadline`: the deadline for this decision version passed
 * and was handled. Refused for a changed, answered or already-handled
 * version, which keeps it once per version, and `accepted` is refused unless
 * the user's opt-in still covers this version.
 */
export const decideStatusDeadline = Effect.fn("decideStatusDeadline")(function* (
  readModel: OrchestrationReadModel,
  command: StatusDeadlineCommand,
): Effect.fn.Return<
  PlannedOrchestrationEvent,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const found = decisionAt(readModel, command);
  if (typeof found === "string") return yield* invariant(command.type, found);
  const { status, decision } = found;
  if (decision.deadlineHandled !== undefined || decision.answeredAt !== undefined) {
    return yield* invariant(command.type, "That deadline no longer needs handling.");
  }
  // An opt-in withdrawn after the sweep read it turns the answer into a
  // reminder. The reactor sends the message for whatever outcome is stored.
  const outcome =
    command.outcome === "accepted" && !isAutoAcceptArmed(decision) ? "reminded" : command.outcome;
  // Keeps updatedAt: handling a deadline is not the coordinator checking in.
  return yield* statusEvent(command, status.id, {
    ...status,
    decision: { ...decision, deadlineHandled: { at: command.createdAt, outcome } },
  });
});

/**
 * `project.status.automate`: the user's own opt-in or opt-out. Only clients
 * send it; the decision must still be the version the user saw.
 */
export const decideStatusAutomate = Effect.fn("decideStatusAutomate")(function* (
  readModel: OrchestrationReadModel,
  command: StatusAutomateCommand,
): Effect.fn.Return<
  PlannedOrchestrationEvent,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const found = decisionAt(readModel, command);
  if (typeof found === "string") return yield* invariant(command.type, found);
  const { status, decision } = found;
  if (
    command.enabled &&
    (decision.deadline === undefined ||
      Date.parse(decision.deadline) <= Date.parse(command.createdAt))
  ) {
    return yield* invariant(command.type, "This decision has no deadline still ahead to act at.");
  }
  if (decision.deadlineHandled !== undefined || decision.answeredAt !== undefined) {
    return yield* invariant(command.type, "This decision is no longer waiting on its deadline.");
  }
  const { autoAccept: _previous, ...rest } = decision;
  return yield* statusEvent(command, status.id, {
    ...status,
    decision: command.enabled
      ? { ...rest, autoAccept: { openedAt: decision.openedAt, enabledAt: command.createdAt } }
      : rest,
  });
});

/**
 * The user's own message (no `source`) in a coordinator thread that starts
 * `Re: <title>` answers that workstream's open decision. Planned with the
 * message itself, so no deadline can act between the reply and its record.
 */
export const statusReplyEvents = Effect.fn("statusReplyEvents")(function* (
  readModel: OrchestrationReadModel,
  input: {
    readonly threadId: ThreadId;
    readonly text: string;
    readonly hasSource: boolean;
    readonly commandId: OrchestrationCommand["commandId"];
    readonly createdAt: string;
  },
): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  if (input.hasSource) return [];
  const reply = parseStatusReply(input.text);
  if (reply === null) return [];
  const project = readModel.projects.find(
    (entry) => entry.deletedAt === null && entry.assistant?.coordinatorThreadId === input.threadId,
  );
  // The id survives renames; a header without one (typed by hand) falls back to the title.
  const folded = reply.title.toLowerCase();
  const status = project?.assistant?.statuses?.find((entry) =>
    reply.statusId !== undefined
      ? entry.id === reply.statusId
      : entry.title.toLowerCase() === folded,
  );
  const decision = status?.decision;
  if (project === undefined || status === undefined || decision === undefined) return [];
  if (decision.answeredAt !== undefined) return [];
  // A reply to an earlier version of the question does not answer this one.
  if (reply.revision !== undefined && reply.revision !== Date.parse(decision.openedAt)) return [];
  const base = yield* withEventBase({
    aggregateKind: "project",
    aggregateId: project.id,
    occurredAt: input.createdAt,
    commandId: input.commandId,
  });
  return [
    {
      ...base,
      type: "project.status-updated" as const,
      payload: {
        projectId: project.id,
        statusId: status.id,
        status: { ...status, decision: { ...decision, answeredAt: input.createdAt } },
      },
    },
  ];
});

/**
 * Unarchiving drops opt-ins whose deadline passed while archived, so an old
 * opt-in cannot act weeks late; those deadlines get a reminder instead.
 */
export function withoutLapsedOptIns(
  statuses: ReadonlyArray<ProjectStatus>,
  now: string,
): ReadonlyArray<ProjectStatus> {
  return statuses.map((status) => {
    const decision = status.decision;
    if (
      decision?.autoAccept === undefined ||
      decision.deadline === undefined ||
      Date.parse(decision.deadline) > Date.parse(now)
    ) {
      return status;
    }
    const { autoAccept: _lapsed, ...rest } = decision;
    return { ...status, decision: rest };
  });
}

/** The marker with one record written (in place, or appended) or removed (`null`). */
export function withStatus(
  assistant: ProjectAssistant,
  statusId: string,
  status: ProjectStatus | null,
): ProjectAssistant {
  const stored = assistant.statuses ?? [];
  const next =
    status === null
      ? stored.filter((entry) => entry.id !== statusId)
      : stored.some((entry) => entry.id === statusId)
        ? stored.map((entry) => (entry.id === statusId ? status : entry))
        : [...stored, status];
  const { statuses: _statuses, ...marker } = assistant;
  return next.length > 0 ? { ...marker, statuses: next } : marker;
}
