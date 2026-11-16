/**
 * Task edits made without the server: the phone writes straight to the
 * cloud task store while the Mac sleeps. Mirrors the server's task decider
 * for the fields the cloud carries (title, notes, status, home, recurrence,
 * order); Control Plane-only fields (links, proposals, handoffs) are left
 * alone because only the Mac owns them.
 */
import {
  followingTaskOccurrence,
  withTaskOccurrence,
  type Task,
  type TaskDeleteScope,
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
      ? { recurrence: withTaskOccurrence(input.recurrence, 1) }
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
      : patch.recurrence !== undefined
        ? withTaskOccurrence(patch.recurrence, stored.recurrence?.occurrence ?? 1)
        : home.kind === "date"
          ? stored.recurrence
          : undefined;
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
  const { recurrence: _rule, ...closed } = next;
  const following = followingOf(next, now, newId, true);
  return following === null ? [closed] : [closed, following];
}

/** The series' next occurrence after `task`, or null when it ends there. */
function followingOf(task: Task, now: string, newId: () => TaskId, counted: boolean): Task | null {
  if (task.recurrence === undefined || task.home.kind !== "date") return null;
  const following = followingTaskOccurrence(task.home.date, task.recurrence, counted);
  if (following === null) return null;
  const {
    completedAt: _done,
    handoff: _handoff,
    completionPromptDismissedAt: _prompt,
    importSource: _importSource,
    proposal: _proposal,
    ...carried
  } = task;
  return {
    ...carried,
    id: newId(),
    status: "todo",
    home: { ...task.home, date: following.date },
    recurrence: following.recurrence,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Deletes a task the way the server does. Returns, in order, the records to
 * write (a task, or null for a delete). A repeating task follows Lucive: by
 * default this occurrence is skipped and the next one opens; with scope
 * "series" the repeat stops first, so the synced series is retired, and this
 * pending occurrence is deleted.
 */
export function deleteLocalTask(
  stored: Task,
  scope: TaskDeleteScope | undefined,
  now: string,
  newId: () => TaskId,
): ReadonlyArray<{ readonly id: TaskId; readonly task: Task | null }> {
  const removed = { id: stored.id, task: null };
  if (stored.recurrence === undefined || stored.home.kind !== "date") return [removed];
  if (scope === "series") {
    const { recurrence: _rule, ...plain } = stored;
    return [{ id: stored.id, task: { ...plain, updatedAt: now } }, removed];
  }
  if (stored.status !== "todo") return [removed];
  const following = followingOf(stored, now, newId, false);
  return following === null ? [removed] : [removed, { id: following.id, task: following }];
}
