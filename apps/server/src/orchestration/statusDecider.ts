/**
 * Project Status board invariants for the decider. Fork-owned and pure, so
 * each decider.ts hunk stays a single call.
 *
 * Only the coordinator writes, one record per command, so a write built from
 * a stale read never touches another workstream. Every write stamps
 * `updatedAt`, which is what the UI ages and marks stale. A decision's
 * `openedAt` restamps when its question or deadline changes, so a deadline
 * reminder is owed at most once per version.
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
  type ThreadId,
} from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { withEventBase, type PlannedOrchestrationEvent } from "./eventBase.ts";

type StatusSetCommand = Extract<OrchestrationCommand, { type: "project.status.set" }>;
type StatusRemindCommand = Extract<OrchestrationCommand, { type: "project.status.remind" }>;
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
    change.ifNoReply !== undefined ||
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
  const ifNoReply = optionalText(change.ifNoReply, stored?.ifNoReply);
  const sameVersion =
    stored !== undefined && stored.question === question && stored.deadline === deadline;
  return {
    decision: {
      question,
      recommendation,
      ...(ifNoReply !== undefined ? { ifNoReply } : {}),
      ...(deadline !== undefined ? { deadline } : {}),
      openedAt: sameVersion ? stored.openedAt : now,
      ...(sameVersion && stored.remindedAt !== undefined ? { remindedAt: stored.remindedAt } : {}),
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
    tooLong("The recommendation", change.recommendation, PROJECT_STATUS_LINE_MAX) ??
    tooLong("ifNoReply", change.ifNoReply?.trim(), PROJECT_STATUS_LINE_MAX);
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
  command: StatusSetCommand | StatusRemindCommand,
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
 * `project.status.remind`: the deadline reminder for this decision version
 * went out. Refused when the decision changed or was already reminded, which
 * keeps the reminder once per version.
 */
export const decideStatusRemind = Effect.fn("decideStatusRemind")(function* (
  readModel: OrchestrationReadModel,
  command: StatusRemindCommand,
): Effect.fn.Return<
  PlannedOrchestrationEvent,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  const project = readModel.projects.find((entry) => entry.id === command.projectId);
  const status =
    project?.deletedAt === null
      ? project.assistant?.statuses?.find((entry) => entry.id === command.statusId)
      : undefined;
  const decision = status?.decision;
  if (
    status === undefined ||
    decision === undefined ||
    decision.openedAt !== command.openedAt ||
    decision.remindedAt !== undefined
  ) {
    return yield* invariant(command.type, "That decision is no longer waiting on a reminder.");
  }
  // Keeps updatedAt: a reminder is not the coordinator checking in.
  return yield* statusEvent(command, status.id, {
    ...status,
    decision: { ...decision, remindedAt: command.createdAt },
  });
});

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
