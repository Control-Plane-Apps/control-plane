/**
 * Task invariants for the decider. Fork-owned and pure, so each decider.ts
 * hunk stays a single call.
 *
 * Every write emits the whole record (`task.updated`), like Status. Client
 * commands create, edit and accept tasks. A coordinator proposes through
 * `cp_task_propose` and edits only its own Project's proposals through
 * `cp_task_update`, and withdraws them through `cp_task_delete`; the
 * Assistant may also add tasks directly, edit, cancel, reorder, delete and
 * restore any task, withdraw any proposal, and add or dismiss a proposal for
 * the user (`task.agent.respond`; its settings, and that the user asked, are
 * the tool's to check, which this pure decider cannot read). A coordinator
 * never adds or dismisses a proposal.
 */
import {
  TASK_INTENT_MAX,
  TASK_NOTES_MAX,
  TASK_PROPOSALS_PER_PROJECT_MAX,
  TASK_TITLE_MAX,
  TaskId,
  agentManagerRole,
  isAssistantChannel,
  isTaskLocalDate,
  isProposedTask,
  followingTaskOccurrence,
  withTaskOccurrence,
  taskIntentKey,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ProjectId,
  type Task,
  type TaskHome,
  type TaskIntent,
  type TaskLinks,
  type TaskPatch,
  type TaskRecurrence,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { withEventBase, type PlannedOrchestrationEvent } from "./eventBase.ts";

type TaskCreateCommand = Extract<OrchestrationCommand, { type: "task.create" }>;
type TaskUpdateCommand = Extract<OrchestrationCommand, { type: "task.update" }>;
type TaskDeleteCommand = Extract<OrchestrationCommand, { type: "task.delete" }>;
type TaskProposalRespondCommand = Extract<OrchestrationCommand, { type: "task.proposal.respond" }>;
type TaskHandoffCommand = Extract<OrchestrationCommand, { type: "task.handoff" }>;
type TaskIntentSetCommand = Extract<OrchestrationCommand, { type: "task.intent.set" }>;
type TaskProposeCommand = Extract<OrchestrationCommand, { type: "task.propose" }>;
type TaskSyncApplyCommand = Extract<OrchestrationCommand, { type: "task.sync.apply" }>;
type TaskAgentCreateCommand = Extract<OrchestrationCommand, { type: "task.agent.create" }>;
type TaskAgentUpdateCommand = Extract<OrchestrationCommand, { type: "task.agent.update" }>;
type TaskAgentDeleteCommand = Extract<OrchestrationCommand, { type: "task.agent.delete" }>;
type TaskAgentRestoreCommand = Extract<OrchestrationCommand, { type: "task.agent.restore" }>;
type TaskAgentRespondCommand = Extract<OrchestrationCommand, { type: "task.agent.respond" }>;
type TaskAgentHandoffCommand = Extract<OrchestrationCommand, { type: "task.agent.handoff" }>;
type TaskCommand =
  | TaskCreateCommand
  | TaskUpdateCommand
  | TaskDeleteCommand
  | TaskProposalRespondCommand
  | TaskHandoffCommand
  | TaskProposeCommand
  | TaskSyncApplyCommand
  | TaskAgentCreateCommand
  | TaskAgentUpdateCommand
  | TaskAgentDeleteCommand
  | TaskAgentRestoreCommand
  | TaskAgentRespondCommand
  | TaskAgentHandoffCommand;

type Decided = Effect.fn.Return<
  PlannedOrchestrationEvent | ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
>;

function invariant(commandType: string, detail: string) {
  return new OrchestrationCommandInvariantError({ commandType, detail });
}

function findTask(readModel: OrchestrationReadModel, taskId: string): Task | undefined {
  return readModel.tasks?.find((task) => task.id === taskId);
}

/** Why `title` or `notes` is refused, or null. */
function textError(title: string | undefined, notes: string | undefined): string | null {
  if (title !== undefined) {
    if (title.length > TASK_TITLE_MAX)
      return `A task title is at most ${TASK_TITLE_MAX} characters.`;
    if (title.includes("\n")) return "A task title is one line.";
  }
  if (notes !== undefined && notes.trim().length > TASK_NOTES_MAX) {
    return `Task notes are at most ${TASK_NOTES_MAX} characters.`;
  }
  return null;
}

function homeError(home: TaskHome): string | null {
  // A real day: 2026-02-30 is refused, not rolled into March.
  const valid = isTaskLocalDate;
  if (home.kind === "date" && !valid(home.date)) return `'${home.date}' is not a date.`;
  if (home.kind === "period") {
    if (!valid(home.startsOn) || !valid(home.endsOn)) return "A period needs real dates.";
    if (home.endsOn < home.startsOn) return "A period cannot end before it starts.";
  }
  return null;
}

function recurrenceError(recurrence: TaskRecurrence | undefined, home: TaskHome): string | null {
  if (recurrence === undefined) return null;
  // The day is the anchor the next occurrence counts from.
  if (home.kind !== "date") return "Only a task scheduled on a day can repeat.";
  if (recurrence.endAfterDate !== undefined && !isTaskLocalDate(recurrence.endAfterDate)) {
    return `'${recurrence.endAfterDate}' is not a date.`;
  }
  return null;
}

/**
 * Which live occurrence a task is in its series, for a rule that ends after
 * a count: the occurrences of its synced series still here, or 1.
 */
function occurrenceOf(readModel: OrchestrationReadModel, task: Task): number {
  if (task.recurrence?.occurrence !== undefined) return task.recurrence.occurrence;
  if (task.seriesId === undefined) return 1;
  return Math.max(
    1,
    (readModel.tasks ?? []).filter((entry) => entry.seriesId === task.seriesId).length,
  );
}

/**
 * The links as stored: a thread fills in its Project, and a workstream must
 * be on that Project's board. Or why they are refused.
 */
function resolveLinks(
  readModel: OrchestrationReadModel,
  links: TaskLinks | null | undefined,
): TaskLinks | undefined | string {
  if (links == null) return undefined;
  let projectId: ProjectId | undefined = links.projectId;
  if (links.threadId !== undefined) {
    const thread = readModel.threads.find((entry) => entry.id === links.threadId);
    if (thread === undefined || thread.deletedAt !== null) {
      return `'${links.threadId}' is not a thread.`;
    }
    if (projectId !== undefined && projectId !== thread.projectId) {
      return "That thread belongs to another Project.";
    }
    projectId = thread.projectId;
  }
  if (projectId !== undefined) {
    const project = readModel.projects.find((entry) => entry.id === projectId);
    if (project === undefined || project.deletedAt !== null) {
      return `'${projectId}' is not a Project.`;
    }
    if (
      links.statusId !== undefined &&
      !(project.assistant?.statuses ?? []).some((status) => status.id === links.statusId)
    ) {
      return `There is no workstream '${links.statusId}' in that Project.`;
    }
  } else if (links.statusId !== undefined) {
    return "A workstream link needs its Project.";
  }
  const resolved: TaskLinks = {
    ...(projectId !== undefined ? { projectId } : {}),
    ...(links.threadId !== undefined ? { threadId: links.threadId } : {}),
    ...(links.statusId !== undefined ? { statusId: links.statusId } : {}),
  };
  return Object.keys(resolved).length === 0 ? undefined : resolved;
}

function taskEvent(command: TaskCommand | TaskIntentSetCommand, taskId: string, task: Task | null) {
  return Effect.map(
    withEventBase({
      aggregateKind: "task",
      aggregateId: TaskId.make(taskId),
      occurredAt: command.createdAt,
      commandId: command.commandId,
    }),
    (base): PlannedOrchestrationEvent => ({
      ...base,
      type: "task.updated" as const,
      payload: { taskId: TaskId.make(taskId), task },
    }),
  );
}

/** Applies a user edit to a stored task, or says why not. */
function applyPatch(
  readModel: OrchestrationReadModel,
  stored: Task,
  patch: TaskPatch,
  now: string,
): Task | string {
  const error = textError(patch.title, patch.notes);
  if (error !== null) return error;
  const home = patch.home ?? stored.home;
  const homeProblem = homeError(home);
  if (homeProblem !== null) return homeProblem;
  // Moving a repeating task off its day drops the repeat rather than refusing the move.
  const recurrence =
    patch.recurrence === null
      ? undefined
      : patch.recurrence !== undefined
        ? withTaskOccurrence(patch.recurrence, occurrenceOf(readModel, stored))
        : home.kind === "date"
          ? stored.recurrence
          : undefined;
  const recurrenceProblem = recurrenceError(recurrence, home);
  if (recurrenceProblem !== null) return recurrenceProblem;
  const links = patch.links === undefined ? stored.links : resolveLinks(readModel, patch.links);
  if (typeof links === "string") return links;
  const notes =
    patch.notes === undefined
      ? stored.notes
      : patch.notes.trim().length === 0
        ? undefined
        : patch.notes.trim();
  const status = patch.status ?? stored.status;
  const orderKey = patch.orderKey === undefined ? stored.orderKey : patch.orderKey;
  const promptDismissed =
    patch.completionPromptDismissedAt === undefined
      ? stored.completionPromptDismissedAt
      : (patch.completionPromptDismissedAt ?? undefined);
  const completedAt =
    status === "todo" ? undefined : status === stored.status ? stored.completedAt : now;
  const {
    notes: _notes,
    recurrence: _recurrence,
    links: _links,
    orderKey: _orderKey,
    completionPromptDismissedAt: _prompt,
    completedAt: _completedAt,
    ...rest
  } = stored;
  return {
    ...rest,
    title: patch.title ?? stored.title,
    status,
    home,
    ...(notes !== undefined ? { notes } : {}),
    ...(recurrence !== undefined ? { recurrence } : {}),
    ...(orderKey !== undefined ? { orderKey } : {}),
    ...(links !== undefined ? { links } : {}),
    ...(promptDismissed !== undefined ? { completionPromptDismissedAt: promptDismissed } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    updatedAt: now,
  };
}

/**
 * Completing a repeating task closes this occurrence and opens the next one
 * on its next day, keeping title, notes, links, reminder and order.
 */
const nextOccurrence = Effect.fn("nextOccurrence")(function* (
  completed: Task,
  now: string,
  counted: boolean = true,
) {
  if (completed.recurrence === undefined || completed.home.kind !== "date") return null;
  // An end condition (after N occurrences, or on a date) stops the series here.
  const following = followingTaskOccurrence(completed.home.date, completed.recurrence, counted);
  if (following === null) return null;
  const crypto = yield* Crypto.Crypto;
  const id = TaskId.make(yield* crypto.randomUUIDv4);
  const date = following.date;
  const {
    completedAt: _completedAt,
    handoff: _handoff,
    completionPromptDismissedAt: _prompt,
    importSource: _importSource,
    proposal: _proposal,
    ...rest
  } = completed;
  const next: Task = {
    ...rest,
    id,
    status: "todo",
    home: { ...completed.home, date },
    recurrence: following.recurrence,
    createdAt: now,
    updatedAt: now,
  };
  return next;
});

export const decideTaskCreate = Effect.fn("decideTaskCreate")(function* (
  readModel: OrchestrationReadModel,
  command: TaskCreateCommand,
): Decided {
  if (findTask(readModel, command.taskId) !== undefined) {
    return yield* invariant(command.type, `Task '${command.taskId}' already exists.`);
  }
  if (
    command.importSource !== undefined &&
    (readModel.tasks ?? []).some(
      (task) =>
        task.importSource?.kind === command.importSource!.kind &&
        task.importSource.id === command.importSource!.id,
    )
  ) {
    return yield* invariant(command.type, "That task was already imported.");
  }
  const problem =
    textError(command.title, command.notes) ??
    homeError(command.home) ??
    recurrenceError(command.recurrence, command.home);
  if (problem !== null) return yield* invariant(command.type, problem);
  const links = resolveLinks(readModel, command.links);
  if (typeof links === "string") return yield* invariant(command.type, links);
  const notes = command.notes?.trim();
  const task: Task = {
    id: command.taskId,
    title: command.title,
    ...(notes !== undefined && notes.length > 0 ? { notes } : {}),
    status: "todo",
    home: command.home,
    ...(command.recurrence !== undefined
      ? { recurrence: withTaskOccurrence(command.recurrence, 1) }
      : {}),
    ...(command.orderKey != null ? { orderKey: command.orderKey } : {}),
    ...(links !== undefined ? { links } : {}),
    ...(command.importSource !== undefined ? { importSource: command.importSource } : {}),
    createdAt: command.createdAt,
    updatedAt: command.createdAt,
  };
  return yield* taskEvent(command, task.id, task);
});

export const decideTaskUpdate = Effect.fn("decideTaskUpdate")(function* (
  readModel: OrchestrationReadModel,
  command: TaskUpdateCommand,
): Decided {
  const stored = findTask(readModel, command.taskId);
  if (stored === undefined) return yield* invariant(command.type, "That task no longer exists.");
  if (isProposedTask(stored)) {
    return yield* invariant(command.type, "Add the proposed task before editing it.");
  }
  const next = applyPatch(readModel, stored, command.patch, command.createdAt);
  if (typeof next === "string") return yield* invariant(command.type, next);
  return yield* writeEdit(command, stored, next);
});

/** Writes an edited task; completing a repeating one also opens its next occurrence. */
const writeEdit = Effect.fn("writeEdit")(function* (
  command: TaskUpdateCommand | TaskAgentUpdateCommand,
  stored: Task,
  next: Task,
): Decided {
  const written = yield* taskEvent(command, next.id, next);
  if (stored.status === "completed" || next.status !== "completed") return written;
  const following = yield* nextOccurrence(next, command.createdAt);
  if (following === null) return written;
  // The closed occurrence stops repeating; the new one carries the rule.
  const { recurrence: _recurrence, ...closed } = next;
  return [
    yield* taskEvent(command, closed.id, closed),
    yield* taskEvent(command, following.id, following),
  ];
});

/**
 * The events that delete `stored`. A repeating task follows Lucive: by
 * default this occurrence is skipped and the series goes on from its next
 * day, as when it is completed (a skip does not count toward an end after N
 * occurrences); with scope "series" the repeat stops first, so Task Sync
 * retires the series, and this pending occurrence is deleted.
 */
const deleteEvents = Effect.fn("deleteEvents")(function* (
  command: TaskDeleteCommand | TaskAgentDeleteCommand,
  stored: Task,
): Decided {
  const repeating = stored.recurrence !== undefined && stored.home.kind === "date";
  if (command.scope !== undefined && !repeating) {
    return yield* invariant(command.type, "That task does not repeat.");
  }
  if (!repeating) return yield* taskEvent(command, stored.id, null);
  if (command.scope === "series") {
    const { recurrence: _recurrence, ...plain } = stored;
    return [
      yield* taskEvent(command, stored.id, { ...plain, updatedAt: command.createdAt }),
      yield* taskEvent(command, stored.id, null),
    ];
  }
  if (stored.status !== "todo") return yield* taskEvent(command, stored.id, null);
  const following = yield* nextOccurrence(stored, command.createdAt, false);
  const removed = yield* taskEvent(command, stored.id, null);
  return following === null
    ? removed
    : [removed, yield* taskEvent(command, following.id, following)];
});

export const decideTaskDelete = Effect.fn("decideTaskDelete")(function* (
  readModel: OrchestrationReadModel,
  command: TaskDeleteCommand,
): Decided {
  const stored = findTask(readModel, command.taskId);
  if (stored === undefined) {
    return yield* invariant(command.type, "That task no longer exists.");
  }
  // A waiting proposal is dismissed, never skipped as an occurrence.
  if (isProposedTask(stored)) return yield* taskEvent(command, stored.id, null);
  return yield* deleteEvents(command, stored);
});

/** `task.proposal.respond`: the user adds or dismisses a proposal. */
export const decideTaskProposalRespond = Effect.fn("decideTaskProposalRespond")(function* (
  readModel: OrchestrationReadModel,
  command: TaskProposalRespondCommand,
): Decided {
  return yield* respondToProposal(readModel, command);
});

/**
 * `task.agent.respond`: the Assistant adds or dismisses a waiting proposal on
 * the user's behalf (the tool allows it only when the user asked).
 */
export const decideTaskAgentRespond = Effect.fn("decideTaskAgentRespond")(function* (
  readModel: OrchestrationReadModel,
  command: TaskAgentRespondCommand,
): Decided {
  if (assistantActor(readModel, command.actorThreadId) === undefined) {
    return yield* invariant(
      command.type,
      "Only the user and the Assistant add or dismiss a proposal.",
    );
  }
  return yield* respondToProposal(readModel, command);
});

const respondToProposal = Effect.fn("respondToProposal")(function* (
  readModel: OrchestrationReadModel,
  command: TaskProposalRespondCommand | TaskAgentRespondCommand,
): Decided {
  const stored = findTask(readModel, command.taskId);
  if (stored === undefined || !isProposedTask(stored)) {
    return yield* invariant(command.type, "That proposal is no longer waiting.");
  }
  if (!command.accept) return yield* taskEvent(command, stored.id, null);
  const accepted: Task = {
    ...stored,
    proposal: { ...stored.proposal!, acceptedAt: command.createdAt },
    updatedAt: command.createdAt,
  };
  const next =
    command.patch === undefined
      ? accepted
      : applyPatch(readModel, accepted, command.patch, command.createdAt);
  if (typeof next === "string") return yield* invariant(command.type, next);
  return yield* taskEvent(command, next.id, next);
});

/** `task.handoff`: links the task to the thread that now has it as its brief. */
export const decideTaskHandoff = Effect.fn("decideTaskHandoff")(function* (
  readModel: OrchestrationReadModel,
  command: TaskHandoffCommand,
): Decided {
  return yield* handOff(readModel, command);
});

/** `task.agent.handoff`: the Assistant hands a task to a thread, or clears it. */
export const decideTaskAgentHandoff = Effect.fn("decideTaskAgentHandoff")(function* (
  readModel: OrchestrationReadModel,
  command: TaskAgentHandoffCommand,
): Decided {
  if (assistantActor(readModel, command.actorThreadId) === undefined) {
    return yield* invariant(command.type, "Only the user and the Assistant hand tasks off.");
  }
  return yield* handOff(readModel, command);
});

const handOff = Effect.fn("handOff")(function* (
  readModel: OrchestrationReadModel,
  command: TaskHandoffCommand | TaskAgentHandoffCommand,
): Decided {
  const stored = findTask(readModel, command.taskId);
  if (stored === undefined) return yield* invariant(command.type, "That task no longer exists.");
  if (isProposedTask(stored)) {
    return yield* invariant(command.type, "Add the proposed task before handing it off.");
  }
  if (command.handoff === null) {
    const { handoff: _handoff, ...rest } = stored;
    return yield* taskEvent(command, stored.id, { ...rest, updatedAt: command.createdAt });
  }
  const links = resolveLinks(readModel, {
    ...(stored.links?.statusId !== undefined && stored.links.projectId !== undefined
      ? { statusId: stored.links.statusId }
      : {}),
    threadId: command.handoff.threadId,
  });
  if (typeof links === "string") return yield* invariant(command.type, links);
  return yield* taskEvent(command, stored.id, {
    ...stored,
    ...(links !== undefined ? { links } : {}),
    handoff: command.handoff,
    updatedAt: command.createdAt,
  });
});

/** `task.propose`: one coordinator suggestion for the user's list. */
export const decideTaskPropose = Effect.fn("decideTaskPropose")(function* (
  readModel: OrchestrationReadModel,
  command: TaskProposeCommand,
): Decided {
  const project = readModel.projects.find((entry) => entry.id === command.projectId);
  if (project === undefined || project.deletedAt !== null) {
    return yield* invariant(command.type, `'${command.projectId}' is not a Project.`);
  }
  const actor = readModel.threads.find((thread) => thread.id === command.actorThreadId);
  // The tool checks this too; the decider keeps it true for any caller.
  if (
    actor === undefined ||
    actor.deletedAt !== null ||
    actor.archivedAt !== null ||
    (agentManagerRole(project, actor) !== "coordinator" && !isAssistantChannel(project, actor))
  ) {
    return yield* invariant(command.type, "Only the Project's coordinator can propose tasks.");
  }
  if (findTask(readModel, command.taskId) !== undefined) {
    return yield* invariant(command.type, `Task '${command.taskId}' already exists.`);
  }
  const waiting = (readModel.tasks ?? []).filter(
    (task) => isProposedTask(task) && task.proposal?.projectId === command.projectId,
  );
  if (waiting.length >= TASK_PROPOSALS_PER_PROJECT_MAX) {
    return yield* invariant(
      command.type,
      `At most ${TASK_PROPOSALS_PER_PROJECT_MAX} proposed tasks wait at once. Let the user add or dismiss some first.`,
    );
  }
  const folded = command.title.toLowerCase();
  if (waiting.some((task) => task.title.toLowerCase() === folded)) {
    return yield* invariant(command.type, `'${command.title}' is already proposed.`);
  }
  const problem = textError(command.title, command.notes) ?? homeError(command.home);
  if (problem !== null) return yield* invariant(command.type, problem);
  const links = resolveLinks(readModel, {
    projectId: command.projectId,
    ...(command.statusId !== undefined ? { statusId: command.statusId } : {}),
  });
  if (typeof links === "string") return yield* invariant(command.type, links);
  const notes = command.notes?.trim();
  const task: Task = {
    id: command.taskId,
    title: command.title,
    ...(notes !== undefined && notes.length > 0 ? { notes } : {}),
    status: "todo",
    home: command.home,
    ...(links !== undefined ? { links } : {}),
    proposal: {
      projectId: command.projectId,
      threadId: command.actorThreadId,
      proposedAt: command.createdAt,
    },
    createdAt: command.createdAt,
    updatedAt: command.createdAt,
  };
  return yield* taskEvent(command, task.id, task);
});

/** The live thread behind an agent command and its Project, or undefined. */
function liveActor(readModel: OrchestrationReadModel, threadId: string) {
  const thread = readModel.threads.find((entry) => entry.id === threadId);
  if (thread === undefined || thread.deletedAt !== null || thread.archivedAt !== null) {
    return undefined;
  }
  const project = readModel.projects.find((entry) => entry.id === thread.projectId);
  if (project === undefined || project.deletedAt !== null) return undefined;
  return { thread, project };
}

/** `task.agent.create`: the Assistant adds a task straight to the user's list. */
export const decideTaskAgentCreate = Effect.fn("decideTaskAgentCreate")(function* (
  readModel: OrchestrationReadModel,
  command: TaskAgentCreateCommand,
): Decided {
  const actor = liveActor(readModel, command.actorThreadId);
  if (actor === undefined || !isAssistantChannel(actor.project, actor.thread)) {
    return yield* invariant(command.type, "Only the Assistant can add tasks directly.");
  }
  if (findTask(readModel, command.taskId) !== undefined) {
    return yield* invariant(command.type, `Task '${command.taskId}' already exists.`);
  }
  const problem =
    textError(command.title, command.notes) ??
    homeError(command.home) ??
    recurrenceError(command.recurrence, command.home);
  if (problem !== null) return yield* invariant(command.type, problem);
  const links = resolveLinks(readModel, command.links);
  if (typeof links === "string") return yield* invariant(command.type, links);
  const notes = command.notes?.trim();
  const task: Task = {
    id: command.taskId,
    title: command.title,
    ...(notes !== undefined && notes.length > 0 ? { notes } : {}),
    status: "todo",
    home: command.home,
    ...(command.recurrence !== undefined
      ? { recurrence: withTaskOccurrence(command.recurrence, 1) }
      : {}),
    ...(links !== undefined ? { links } : {}),
    createdAt: command.createdAt,
    updatedAt: command.createdAt,
  };
  return yield* taskEvent(command, task.id, task);
});

/**
 * `task.agent.update`: the Assistant edits any task; a coordinator edits only
 * tasks its Project proposed, and never completes or reopens one. Nobody but
 * the user adds or dismisses a waiting proposal, so its status stays put.
 */
export const decideTaskAgentUpdate = Effect.fn("decideTaskAgentUpdate")(function* (
  readModel: OrchestrationReadModel,
  command: TaskAgentUpdateCommand,
): Decided {
  const stored = findTask(readModel, command.taskId);
  if (stored === undefined) return yield* invariant(command.type, "That task no longer exists.");
  const actor = liveActor(readModel, command.actorThreadId);
  const assistant = actor !== undefined && isAssistantChannel(actor.project, actor.thread);
  const coordinator =
    actor !== undefined && agentManagerRole(actor.project, actor.thread) === "coordinator";
  if (!assistant) {
    if (!coordinator || stored.proposal?.projectId !== actor.project.id) {
      return yield* invariant(
        command.type,
        "You can only edit tasks this Project proposed. Ask the user to change the others.",
      );
    }
    if (command.patch.status !== undefined && command.patch.status !== stored.status) {
      return yield* invariant(command.type, "Only the user completes, cancels or reopens a task.");
    }
    if (command.patch.orderKey !== undefined) {
      return yield* invariant(command.type, "Only the user and the Assistant reorder tasks.");
    }
    if (command.patch.recurrence !== undefined || command.patch.links !== undefined) {
      return yield* invariant(
        command.type,
        "Only the user and the Assistant change a task's repeat or links.",
      );
    }
    if (command.patch.completionPromptDismissedAt !== undefined) {
      return yield* invariant(command.type, "Only the user and the Assistant answer that prompt.");
    }
  }
  if (
    isProposedTask(stored) &&
    command.patch.status !== undefined &&
    command.patch.status !== stored.status
  ) {
    return yield* invariant(
      command.type,
      "That task is still a proposal: add or dismiss it (cp_task_proposal_respond), or withdraw it (cp_task_delete), instead of changing its status.",
    );
  }
  const next = applyPatch(readModel, stored, command.patch, command.createdAt);
  if (typeof next === "string") return yield* invariant(command.type, next);
  return yield* writeEdit(command, stored, next);
});

/** The live Assistant behind an agent command, or undefined. */
function assistantActor(readModel: OrchestrationReadModel, threadId: string) {
  const actor = liveActor(readModel, threadId);
  return actor !== undefined && isAssistantChannel(actor.project, actor.thread) ? actor : undefined;
}

/**
 * `task.agent.delete`: the Assistant deletes a task the same way the user's
 * Delete does, so Task Sync tombstones a synced record instead of losing it.
 * Deleting a waiting proposal withdraws it: the Assistant may withdraw any,
 * a coordinator only its own Project's.
 */
export const decideTaskAgentDelete = Effect.fn("decideTaskAgentDelete")(function* (
  readModel: OrchestrationReadModel,
  command: TaskAgentDeleteCommand,
): Decided {
  const stored = findTask(readModel, command.taskId);
  if (stored === undefined) return yield* invariant(command.type, "That task no longer exists.");
  const actor = liveActor(readModel, command.actorThreadId);
  const assistant = actor !== undefined && isAssistantChannel(actor.project, actor.thread);
  if (isProposedTask(stored)) {
    const ownCoordinator =
      actor !== undefined &&
      agentManagerRole(actor.project, actor.thread) === "coordinator" &&
      stored.proposal?.projectId === actor.project.id;
    if (!assistant && !ownCoordinator) {
      return yield* invariant(command.type, "You can only withdraw proposals this Project made.");
    }
    if (command.scope !== undefined) {
      return yield* invariant(command.type, "A proposal does not repeat.");
    }
    return yield* taskEvent(command, stored.id, null);
  }
  if (!assistant) {
    return yield* invariant(command.type, "Only the Assistant can delete tasks.");
  }
  return yield* deleteEvents(command, stored);
});

/**
 * `task.agent.restore`: writes a deleted task's last record back under its
 * own id. Links to a Project or thread that is gone are dropped rather than
 * refusing the restore.
 */
export const decideTaskAgentRestore = Effect.fn("decideTaskAgentRestore")(function* (
  readModel: OrchestrationReadModel,
  command: TaskAgentRestoreCommand,
): Decided {
  if (assistantActor(readModel, command.actorThreadId) === undefined) {
    return yield* invariant(command.type, "Only the Assistant can restore tasks.");
  }
  const record = command.task;
  if (record.id !== command.taskId) {
    return yield* invariant(command.type, "The restored record belongs to another task.");
  }
  if (findTask(readModel, command.taskId) !== undefined) {
    return yield* invariant(command.type, "That task was not deleted.");
  }
  if (isProposedTask(record)) {
    // A withdrawn proposal comes back waiting, within its Project's limit.
    const owner = readModel.projects.find((entry) => entry.id === record.proposal!.projectId);
    if (owner === undefined || owner.deletedAt !== null) {
      return yield* invariant(command.type, "The Project that proposed it is gone.");
    }
    const waiting = (readModel.tasks ?? []).filter(
      (task) => isProposedTask(task) && task.proposal?.projectId === record.proposal!.projectId,
    );
    if (waiting.length >= TASK_PROPOSALS_PER_PROJECT_MAX) {
      return yield* invariant(
        command.type,
        `At most ${TASK_PROPOSALS_PER_PROJECT_MAX} proposed tasks wait at once for that Project.`,
      );
    }
  }
  const source = record.importSource;
  if (
    source !== undefined &&
    (readModel.tasks ?? []).some(
      (task) => task.importSource?.kind === source.kind && task.importSource.id === source.id,
    )
  ) {
    return yield* invariant(command.type, "Another task already carries that synced record.");
  }
  const problem = homeError(record.home) ?? recurrenceError(record.recurrence, record.home);
  if (problem !== null) return yield* invariant(command.type, problem);
  const links = resolveLinks(readModel, record.links);
  const { links: _links, handoff, ...rest } = record;
  const keepLinks = typeof links === "string" ? undefined : links;
  const restored: Task = {
    ...rest,
    ...(keepLinks !== undefined ? { links: keepLinks } : {}),
    ...(handoff !== undefined && keepLinks?.threadId === handoff.threadId ? { handoff } : {}),
    updatedAt: command.createdAt,
  };
  return yield* taskEvent(command, restored.id, restored);
});

export const decideTaskIntentSet = Effect.fn("decideTaskIntentSet")(function* (
  readModel: OrchestrationReadModel,
  command: TaskIntentSetCommand,
): Decided {
  const text = command.text.trim();
  if (text.length > TASK_INTENT_MAX) {
    return yield* invariant(command.type, `An intent is at most ${TASK_INTENT_MAX} characters.`);
  }
  if (Number.isNaN(Date.parse(`${command.startsOn}T00:00:00Z`))) {
    return yield* invariant(command.type, `'${command.startsOn}' is not a date.`);
  }
  const stored = readModel.taskIntents?.find(
    (intent) => intent.horizon === command.horizon && intent.startsOn === command.startsOn,
  );
  if (text.length === 0 && stored === undefined) {
    return yield* invariant(command.type, "There is no intent to clear.");
  }
  const base = yield* withEventBase({
    aggregateKind: "task",
    aggregateId: taskIntentKey(command.horizon, command.startsOn),
    occurredAt: command.createdAt,
    commandId: command.commandId,
  });
  return {
    ...base,
    type: "task.intent-updated" as const,
    payload: {
      horizon: command.horizon,
      startsOn: command.startsOn,
      intent:
        text.length === 0
          ? null
          : {
              horizon: command.horizon,
              startsOn: command.startsOn,
              text,
              updatedAt: command.createdAt,
            },
    },
  } satisfies PlannedOrchestrationEvent;
});

/** Replaces or removes one task in a list, keeping order. */
export function withTask(
  tasks: ReadonlyArray<Task> | undefined,
  taskId: string,
  task: Task | null,
): Task[] {
  const list = tasks ?? [];
  if (task === null) return list.filter((entry) => entry.id !== taskId);
  return list.some((entry) => entry.id === taskId)
    ? list.map((entry) => (entry.id === taskId ? task : entry))
    : [...list, task];
}

/** Fields only Control Plane knows; a pulled record never carries them. */
function withLocalFields(remote: Task, stored: Task | undefined): Task {
  if (stored === undefined) return remote;
  return {
    ...remote,
    ...(stored.links !== undefined ? { links: stored.links } : {}),
    ...(stored.proposal !== undefined ? { proposal: stored.proposal } : {}),
    ...(stored.handoff !== undefined ? { handoff: stored.handoff } : {}),
    ...(stored.completionPromptDismissedAt !== undefined
      ? { completionPromptDismissedAt: stored.completionPromptDismissedAt }
      : {}),
  };
}

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * `task.sync.apply`: records pulled from the synced store. Only real
 * changes become events, so a quiet poll writes nothing.
 */
export const decideTaskSyncApply = Effect.fn("decideTaskSyncApply")(function* (
  readModel: OrchestrationReadModel,
  command: TaskSyncApplyCommand,
): Decided {
  const events: PlannedOrchestrationEvent[] = [];
  for (const remote of command.tasks) {
    const stored = findTask(readModel, remote.id);
    const next = withLocalFields(remote, stored);
    if (stored !== undefined && sameRecord(stored, next)) continue;
    events.push(yield* taskEvent(command, next.id, next));
  }
  for (const taskId of command.removedTaskIds) {
    if (findTask(readModel, taskId) === undefined) continue;
    events.push(yield* taskEvent(command, taskId, null));
  }
  for (const intent of command.intents) {
    const stored = readModel.taskIntents?.find(
      (entry) => entry.horizon === intent.horizon && entry.startsOn === intent.startsOn,
    );
    if (stored !== undefined && stored.text === intent.text) continue;
    events.push(yield* intentEvent(command, intent.horizon, intent.startsOn, intent));
  }
  for (const removed of command.removedIntents) {
    const stored = readModel.taskIntents?.find(
      (entry) => entry.horizon === removed.horizon && entry.startsOn === removed.startsOn,
    );
    if (stored === undefined) continue;
    events.push(yield* intentEvent(command, removed.horizon, removed.startsOn, null));
  }
  if (events.length === 0) {
    return yield* invariant(command.type, "Nothing changed.");
  }
  return events;
});

function intentEvent(
  command: TaskSyncApplyCommand | TaskIntentSetCommand,
  horizon: TaskIntent["horizon"],
  startsOn: string,
  intent: TaskIntent | null,
) {
  return Effect.map(
    withEventBase({
      aggregateKind: "task",
      aggregateId: taskIntentKey(horizon, startsOn),
      occurredAt: command.createdAt,
      commandId: command.commandId,
    }),
    (base): PlannedOrchestrationEvent => ({
      ...base,
      type: "task.intent-updated" as const,
      payload: { horizon, startsOn, intent },
    }),
  );
}
