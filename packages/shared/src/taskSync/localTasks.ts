/**
 * Task edits made without the server: the phone writes straight to the
 * cloud task store while the Mac sleeps. Mirrors the server's task decider
 * for the fields the cloud carries (title, notes, status, home, recurrence,
 * order); Control Plane-only fields (links, proposals, handoffs) are left
 * alone because only the Mac owns them.
 */
import {
  nextTaskOccurrence,
  type Task,
  type TaskHome,
  type TaskId,
  type TaskPatch,
  type TaskRecurrence,
} from "@t3tools/contracts";

export interface LocalTaskInput {
  readonly id: TaskId;
  readonly title: string;
  readonly notes?: string;
  readonly home: TaskHome;
  readonly recurrence?: TaskRecurrence;
}

export function createLocalTask(input: LocalTaskInput, now: string): Task {
  const notes = input.notes?.trim();
  return {
    id: input.id,
    title: input.title.trim(),
    ...(notes !== undefined && notes.length > 0 ? { notes } : {}),
    status: "todo",
    home: input.home,
    ...(input.recurrence !== undefined && input.home.kind === "date"
      ? { recurrence: input.recurrence }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Applies a patch. Completing a repeating task closes this occurrence and
 * returns the next one too, as the server does.
 */
export function patchLocalTask(
  stored: Task,
  patch: TaskPatch,
  now: string,
  newId: () => TaskId,
): ReadonlyArray<Task> {
  const home = patch.home ?? stored.home;
  const recurrence =
    patch.recurrence === null
      ? undefined
      : (patch.recurrence ?? (home.kind === "date" ? stored.recurrence : undefined));
  const notes =
    patch.notes === undefined
      ? stored.notes
      : patch.notes.trim().length === 0
        ? undefined
        : patch.notes.trim();
  const status = patch.status ?? stored.status;
  const orderKey = patch.orderKey === undefined ? stored.orderKey : patch.orderKey;
  const completedAt =
    status === "todo" ? undefined : status === stored.status ? stored.completedAt : now;
  const {
    notes: _notes,
    recurrence: _recurrence,
    orderKey: _orderKey,
    completedAt: _completedAt,
    ...rest
  } = stored;
  const next: Task = {
    ...rest,
    title: patch.title?.trim() || stored.title,
    status,
    home,
    ...(notes !== undefined ? { notes } : {}),
    ...(recurrence !== undefined && home.kind === "date" ? { recurrence } : {}),
    ...(orderKey != null ? { orderKey } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    updatedAt: now,
  };
  if (
    stored.status === "completed" ||
    next.status !== "completed" ||
    next.recurrence === undefined ||
    next.home.kind !== "date"
  ) {
    return [next];
  }
  const { recurrence: rule, ...closed } = next;
  const {
    completedAt: _done,
    handoff: _handoff,
    completionPromptDismissedAt: _prompt,
    importSource: _importSource,
    proposal: _proposal,
    ...carried
  } = next;
  const following: Task = {
    ...carried,
    id: newId(),
    status: "todo",
    home: { ...next.home, date: nextTaskOccurrence(next.home.date, rule) },
    recurrence: rule,
    createdAt: now,
    updatedAt: now,
  };
  return [closed, following];
}
