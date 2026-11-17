/**
 * The `cp_task_*` handlers, spread into the agents toolkit. Fork-owned.
 *
 * Callers: a Project's coordinator, or the Assistant (its "Today" thread and
 * pinned channels). A coordinator lists its Project's tasks, proposes new
 * ones, and edits or withdraws only its own waiting proposals. The Assistant
 * follows the user's Assistant settings: `tasks` (off / read / edit) gates
 * listing and every write (edit, cancel, delete, restore, reorder, bulk,
 * handoff, withdrawing any proposal, and adding or dismissing proposals when
 * the user asks), and `newTasks` ("create" with edit access) adds new tasks
 * directly instead of proposing them. The decider checks the caller's role
 * again; settings are checked only here.
 *
 * Every write goes through the same task commands the UI uses, so Task Sync
 * sees an ordinary local edit: a delete tombstones the synced record, a
 * restore lifts the tombstone under the same id, a reorder writes order keys
 * the way a drag does.
 *
 * @module taskHandlers
 */
import {
  TASK_INTENT_MAX,
  addTaskDays,
  agentManagerRole,
  compareTaskOrder,
  CommandId,
  findGlobalAssistantProject,
  isAssistantChannel,
  isProposedTask,
  isTaskLocalDate,
  localTaskDate,
  taskPeriodFor,
  TaskId,
  taskHandoffDeliveryId,
  ThreadId,
  type AssistantSettings,
  type OrchestrationCommand,
  type Task,
  type TaskAgentPatch,
  type TaskHandoff,
  type TaskHome,
  type TaskOrderKey,
} from "@t3tools/contracts";
import { planPinnedReorder } from "@t3tools/shared/pinOrderKey";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Toolkit from "effect/unstable/ai/Toolkit";

import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStore } from "../../../persistence/Services/OrchestrationEventStore.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { TaskSyncService } from "../../../taskSync/TaskSyncService.ts";
import { TaskCommitmentRollover } from "../../../orchestration/TaskCommitmentRollover.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  type AgentsToolkit,
  AgentToolFailedError,
  TASK_LIST_LIMIT_DEFAULT,
  TaskAccessDeniedError,
  type TaskBulkInput,
  type TaskBulkItem,
  type TaskDeleteInput,
  type TaskHandoffInput,
  type TaskIntentSetInput,
  type TaskListInput,
  type TaskListItem,
  type TaskListRange,
  type TaskProposalRespondInput,
  type TaskProposeInput,
  type TaskReorderInput,
  type TaskRestoreInput,
  type TaskUpdateInput,
  type TaskWhen,
} from "./tools.ts";

type TaskHandlers = Pick<
  Toolkit.HandlersFrom<Toolkit.Tools<typeof AgentsToolkit>>,
  | "cp_task_list"
  | "cp_task_propose"
  | "cp_task_update"
  | "cp_task_delete"
  | "cp_task_restore"
  | "cp_task_reorder"
  | "cp_task_intent_set"
  | "cp_task_bulk"
  | "cp_task_proposal_respond"
  | "cp_task_handoff"
>;

const readFailed = (cause: unknown) =>
  new AgentToolFailedError({ detail: "Could not read the user's tasks.", cause });

const isInvariantError = Schema.is(OrchestrationCommandInvariantError);

const writeFailed =
  (fallback: string) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<never, AgentToolFailedError> => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
    const error = Cause.findErrorOption(cause);
    const detail =
      Option.isSome(error) && isInvariantError(error.value) ? error.value.detail : fallback;
    return Effect.fail(new AgentToolFailedError({ detail, cause }));
  };

const NOT_A_TASK_CALLER =
  "Only a Project's coordinator or the Assistant can use the task tools. Ask your coordinator.";
const ASSISTANT_TASKS_OFF =
  "The user turned off the Assistant's access to tasks (Assistant settings, Tasks: Off).";
const ASSISTANT_TASKS_READ_ONLY =
  "The user's Assistant settings allow reading tasks but not editing them (Tasks: Read only). Tell the user what to change instead.";

/** The tool's `when` as a task home, counted from the server's local today. */
export function taskHomeOf(when: TaskWhen | undefined, today: string): TaskHome {
  const period = (horizon: "week" | "month" | "year", next: boolean): TaskHome => {
    const current = taskPeriodFor(horizon, today);
    const anchor = next ? addTaskDays(current.endsOn, 1) : today;
    return { kind: "period", horizon, ...taskPeriodFor(horizon, anchor) };
  };
  switch (when) {
    case "today":
      return { kind: "date", date: today };
    case "tomorrow":
      return { kind: "date", date: addTaskDays(today, 1) };
    case "next-week":
      return period("week", true);
    case "this-month":
      return period("month", false);
    case "next-month":
      return period("month", true);
    case "this-year":
      return period("year", false);
    case "next-year":
      return period("year", true);
    case "backlog":
      return { kind: "backlog", horizon: null };
    case "week-backlog":
      return { kind: "backlog", horizon: "week" };
    case "month-backlog":
      return { kind: "backlog", horizon: "month" };
    case "year-backlog":
      return { kind: "backlog", horizon: "year" };
    case "this-week":
    case undefined:
      return period("week", false);
  }
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

interface HomeFields {
  readonly when?: TaskWhen | undefined;
  readonly date?: string | undefined;
  readonly period?: "week" | "month" | "year" | undefined;
}

/**
 * The home the tool's fields name, null when they name none, or why they are
 * refused. `when` counts from `today`.
 */
export function resolveTaskHome(fields: HomeFields, today: string): TaskHome | null | string {
  if (fields.when !== undefined && fields.date !== undefined) {
    return "Give either `when` or `date`, not both.";
  }
  if (fields.period !== undefined && fields.date === undefined) {
    return "`period` needs a `date` inside that period. For the current or next one, use `when` (this-week, next-month, ...).";
  }
  if (fields.date !== undefined) {
    if (!isTaskLocalDate(fields.date)) {
      return `'${fields.date}' is not a real date. Use YYYY-MM-DD, such as 2026-11-16.`;
    }
    if (fields.period !== undefined) {
      return {
        kind: "period",
        horizon: fields.period,
        ...taskPeriodFor(fields.period, fields.date),
      };
    }
    return { kind: "date", date: fields.date };
  }
  if (fields.when !== undefined) return taskHomeOf(fields.when, today);
  return null;
}

/** `home` with the reminder applied: a time sets it, null clears it, undefined keeps it. */
export function withReminder(
  home: TaskHome,
  reminderTime: string | null | undefined,
): TaskHome | string {
  if (reminderTime === undefined) return home;
  if (reminderTime !== null && !TIME_PATTERN.test(reminderTime)) {
    return `'${reminderTime}' is not a time. Use 24h HH:MM, such as 09:30.`;
  }
  if (home.kind !== "date") {
    if (reminderTime === null) return home;
    return "A reminder needs a single day: pass `date` alone, or when: today or tomorrow.";
  }
  const { reminderTime: _previous, ...day } = home;
  return reminderTime === null ? day : { ...day, reminderTime };
}

/** An inclusive span of local days, or a backlog filter, that `cp_task_list` matches. */
type TaskListWindow =
  | {
      readonly kind: "span";
      readonly from: string | null;
      readonly to: string;
      readonly openOnly?: true;
    }
  | { readonly kind: "backlog"; readonly horizon: "week" | "month" | "year" | null | "any" };

/** The span or backlog a `range` (or a single `date`) names, or why it is refused. */
export function taskListWindow(
  fields: Pick<TaskListInput, "date" | "range" | "days">,
  today: string,
): TaskListWindow | null | string {
  if (fields.date !== undefined && fields.range !== undefined) {
    return "Give either `date` or `range`, not both.";
  }
  if (fields.days !== undefined && fields.range !== "upcoming") {
    return "`days` goes with range: upcoming.";
  }
  if (fields.date !== undefined) {
    if (!isTaskLocalDate(fields.date)) {
      return `'${fields.date}' is not a real date. Use YYYY-MM-DD, such as 2026-11-16.`;
    }
    return { kind: "span", from: fields.date, to: fields.date };
  }
  const range: TaskListRange | undefined = fields.range;
  const period = (horizon: "week" | "month" | "year", next: boolean): TaskListWindow => {
    const current = taskPeriodFor(horizon, today);
    const target = next ? taskPeriodFor(horizon, addTaskDays(current.endsOn, 1)) : current;
    return { kind: "span", from: target.startsOn, to: target.endsOn };
  };
  switch (range) {
    case undefined:
      return null;
    case "today":
      return { kind: "span", from: today, to: today };
    case "tomorrow": {
      const tomorrow = addTaskDays(today, 1);
      return { kind: "span", from: tomorrow, to: tomorrow };
    }
    case "overdue":
      return { kind: "span", from: null, to: addTaskDays(today, -1), openOnly: true };
    case "this-week":
      return period("week", false);
    case "next-week":
      return period("week", true);
    case "this-month":
      return period("month", false);
    case "next-month":
      return period("month", true);
    case "this-year":
      return period("year", false);
    case "next-year":
      return period("year", true);
    case "upcoming":
      return { kind: "span", from: today, to: addTaskDays(today, (fields.days ?? 7) - 1) };
    case "backlog":
      return { kind: "backlog", horizon: null };
    case "week-backlog":
      return { kind: "backlog", horizon: "week" };
    case "month-backlog":
      return { kind: "backlog", horizon: "month" };
    case "year-backlog":
      return { kind: "backlog", horizon: "year" };
    case "any-backlog":
      return { kind: "backlog", horizon: "any" };
  }
}

function inWindow(home: TaskHome, window: TaskListWindow): boolean {
  if (window.kind === "backlog") {
    return home.kind === "backlog" && (window.horizon === "any" || home.horizon === window.horizon);
  }
  const after = (date: string) => window.from === null || date >= window.from;
  if (home.kind === "date") return after(home.date) && home.date <= window.to;
  // Overdue is about days only; a commitment is never overdue on its own.
  if (home.kind === "period") {
    return window.openOnly !== true && after(home.endsOn) && home.startsOn <= window.to;
  }
  return false;
}

/** Days first (by date), then commitments (by start, week before month before year), then backlogs. */
function homeRank(home: TaskHome): string {
  const horizon = (value: "week" | "month" | "year" | null) =>
    value === "week" ? "1" : value === "month" ? "2" : value === "year" ? "3" : "4";
  switch (home.kind) {
    case "date":
      return `0:${home.date}`;
    case "period":
      return `1:${home.startsOn}:${horizon(home.horizon)}`;
    case "backlog":
      return `2:${horizon(home.horizon)}`;
  }
}

/** One list's identity: tasks with equal keys are drawn and reordered together. */
export function taskListKey(home: TaskHome): string {
  switch (home.kind) {
    case "date":
      return `date:${home.date}`;
    case "period":
      return `period:${home.horizon}:${home.startsOn}`;
    case "backlog":
      return `backlog:${home.horizon ?? "general"}`;
  }
}

/** Display order for listed tasks: by home, then the user's manual order. */
export function compareListedTasks(left: Task, right: Task): number {
  const rank = homeRank(left.home).localeCompare(homeRank(right.home));
  return rank !== 0 ? rank : compareTaskOrder(left, right);
}

/**
 * The order keys that put `wanted` (ids of one list's open tasks) at the top
 * of `list`, in that order, by replaying one drag per task the way the task
 * list does on drop.
 */
export function planTaskReorder(
  list: ReadonlyArray<Pick<Task, "id" | "orderKey">>,
  wanted: ReadonlyArray<string>,
): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> {
  const keys = new Map(list.map((task) => [task.id as string, task.orderKey ?? null]));
  let order = list.map((task) => task.id as string);
  const original = new Map(keys);
  wanted.forEach((movedId, index) => {
    if (order[index] === movedId) return;
    order = order.filter((id) => id !== movedId);
    order.splice(index, 0, movedId);
    for (const assignment of planPinnedReorder({ orderedIds: order, movedId, keysById: keys })) {
      keys.set(assignment.id, assignment.orderKey);
    }
  });
  return [...keys].flatMap(([id, key]) =>
    key !== null && key !== original.get(id) ? [{ id, orderKey: key }] : [],
  );
}

const CURSOR_PATTERN = /^o(\d+)$/;

export const makeTaskHandlers = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  // Optional like Task Sync: the live toolkit always has it (handlers.ts).
  const eventStore = yield* Effect.serviceOption(OrchestrationEventStore);
  // Optional so toolkits built without Task Sync (tests) report nothing as synced.
  const taskSync = yield* Effect.serviceOption(TaskSyncService);
  const syncedTaskIds = Option.isSome(taskSync)
    ? taskSync.value.syncedTaskIds
    : Effect.succeed<ReadonlySet<string>>(new Set());
  // Optional the same way: expired commitments roll before a list reads them.
  const rollover = yield* Effect.serviceOption(TaskCommitmentRollover);
  const rolloverBeforeRead = Option.isSome(rollover) ? rollover.value.beforeRead : Effect.void;

  /** The caller as a coordinator or the Assistant, with the Assistant's settings. */
  const requireCaller = Effect.fn("TaskTools.requireCaller")(function* () {
    const invocation = yield* McpInvocationContext.requireMcpCapability("agents");
    const caller = yield* snapshots
      .getThreadShellById(invocation.threadId)
      .pipe(Effect.mapError(readFailed));
    if (Option.isNone(caller)) {
      return yield* new TaskAccessDeniedError({ detail: NOT_A_TASK_CALLER });
    }
    const project = yield* snapshots
      .getProjectShellById(caller.value.projectId)
      .pipe(Effect.mapError(readFailed));
    if (Option.isNone(project)) {
      return yield* new TaskAccessDeniedError({ detail: NOT_A_TASK_CALLER });
    }
    const assistant = isAssistantChannel(project.value, caller.value);
    if (!assistant && agentManagerRole(project.value, caller.value) !== "coordinator") {
      return yield* new TaskAccessDeniedError({ detail: NOT_A_TASK_CALLER });
    }
    const settings: AssistantSettings | null = assistant
      ? (yield* settingsService.getSettings.pipe(Effect.mapError(readFailed))).assistant
      : null;
    if (settings?.tasks === "off") {
      return yield* new TaskAccessDeniedError({ detail: ASSISTANT_TASKS_OFF });
    }
    return { callerId: caller.value.id, projectId: project.value.id, settings };
  });

  const allTasks = snapshots.getCommandReadModel().pipe(
    Effect.mapError(readFailed),
    Effect.map((model): ReadonlyArray<Task> => model.tasks ?? []),
  );

  /** Tasks the caller sees: every one for the Assistant, else its Project's. */
  const visibleTasks = (projectId: string, assistant: boolean) =>
    allTasks.pipe(
      Effect.map((tasks): Task[] =>
        tasks.filter(
          (task) =>
            assistant ||
            task.links?.projectId === projectId ||
            task.proposal?.projectId === projectId,
        ),
      ),
    );

  /** The caller as the Assistant with edit access, or why not. */
  const requireAssistantEditor = Effect.fn("TaskTools.requireAssistantEditor")(function* (
    coordinatorDetail = "Only the Assistant deletes, restores or reorders the user's tasks, hands them off or sets intents. Ask the user, or propose a change.",
  ) {
    const caller = yield* requireCaller();
    if (caller.settings === null) {
      return yield* new TaskAccessDeniedError({ detail: coordinatorDetail });
    }
    if (caller.settings.tasks !== "edit") {
      return yield* new TaskAccessDeniedError({ detail: ASSISTANT_TASKS_READ_ONLY });
    }
    return caller;
  });

  /**
   * The task as it stood before its latest delete, from the event log. A
   * delete may write the record once more before removing it (stopping a
   * series), so records from the deleting command itself are skipped.
   */
  const lastRecord = (taskId: string) =>
    Option.isNone(eventStore)
      ? Effect.fail(readFailed("The event log is not available."))
      : eventStore.value
          .readAggregateRange({
            aggregateKind: "task",
            aggregateId: taskId,
            fromSequenceExclusive: 0,
            toSequenceInclusive: Number.MAX_SAFE_INTEGER,
            limit: Number.MAX_SAFE_INTEGER,
          })
          .pipe(
            Stream.filter(
              (event) => event.type === "task.updated" && event.payload.taskId === taskId,
            ),
            Stream.runCollect,
            Effect.map((chunk) => {
              const events = [...chunk];
              const deleteAt = events.findLastIndex(
                (event) => event.type === "task.updated" && event.payload.task === null,
              );
              if (deleteAt === -1) return null;
              const deleting = events[deleteAt]!.commandId;
              for (let index = deleteAt - 1; index >= 0; index -= 1) {
                const event = events[index]!;
                if (event.type !== "task.updated" || event.payload.task === null) continue;
                if (event.commandId !== null && event.commandId === deleting) continue;
                return event.payload.task;
              }
              return null;
            }),
            Effect.mapError(readFailed),
          );

  const readIntents = snapshots.getCommandReadModel().pipe(
    Effect.mapError(readFailed),
    Effect.map((model) => model.taskIntents ?? []),
  );

  const findTask = (taskId: string) =>
    allTasks.pipe(Effect.map((tasks) => tasks.find((entry) => entry.id === taskId)));

  const nowParts = Effect.gen(function* () {
    const now = yield* DateTime.now;
    return {
      iso: DateTime.formatIso(now),
      today: localTaskDate(DateTime.toEpochMillis(now)),
    };
  });

  const dispatch = (command: OrchestrationCommand, fallback: string) =>
    engine.dispatch(command).pipe(Effect.catchCause(writeFailed(fallback)));

  const handlers = {
    cp_task_list: (input: TaskListInput) =>
      Effect.gen(function* () {
        const { projectId, settings } = yield* requireCaller();
        yield* rolloverBeforeRead;
        const { today } = yield* nowParts;
        const window = taskListWindow(input, today);
        if (typeof window === "string") {
          return yield* new AgentToolFailedError({ detail: window });
        }
        let offset = 0;
        if (input.cursor !== undefined) {
          const match = CURSOR_PATTERN.exec(input.cursor);
          if (match === null) {
            return yield* new AgentToolFailedError({
              detail: "That cursor is not one cp_task_list returned.",
            });
          }
          offset = Number(match[1]);
        }
        const status = input.status ?? "todo";
        const text = input.text?.trim().toLowerCase();
        const matches = (yield* visibleTasks(projectId, settings !== null))
          .filter(
            (task) =>
              (status === "any" || task.status === status) &&
              (window === null ||
                (inWindow(task.home, window) &&
                  (window.kind !== "span" ||
                    window.openOnly !== true ||
                    task.status === "todo"))) &&
              (text === undefined ||
                text.length === 0 ||
                task.title.toLowerCase().includes(text) ||
                (task.notes ?? "").toLowerCase().includes(text)) &&
              (input.projectId === undefined ||
                task.links?.projectId === input.projectId ||
                task.proposal?.projectId === input.projectId) &&
              (input.repeating === undefined ||
                (task.recurrence !== undefined || task.seriesId !== undefined) ===
                  input.repeating) &&
              (input.proposed === undefined || isProposedTask(task) === input.proposed) &&
              (input.handedOff === undefined || (task.handoff !== undefined) === input.handedOff) &&
              (input.threadId === undefined || task.links?.threadId === input.threadId) &&
              (input.statusId === undefined || task.links?.statusId === input.statusId),
          )
          .toSorted(compareListedTasks);
        const limit = input.limit ?? TASK_LIST_LIMIT_DEFAULT;
        const page = matches.slice(offset, offset + limit);
        const synced = yield* syncedTaskIds;
        const tasks = page.map((task): TaskListItem => ({
          ...task,
          synced: synced.has(task.id) || task.importSource?.kind === "lucive",
        }));
        const next = offset + page.length;
        const intents =
          window === null || window.kind !== "span" || window.from === null
            ? []
            : (yield* readIntents).filter((intent) => {
                const endsOn = taskPeriodFor(intent.horizon, intent.startsOn).endsOn;
                return intent.startsOn <= window.to && endsOn >= window.from!;
              });
        return {
          tasks,
          total: matches.length,
          intents,
          ...(next < matches.length ? { nextCursor: `o${next}` } : {}),
        };
      }),

    cp_task_propose: (input: TaskProposeInput) =>
      Effect.gen(function* () {
        const { callerId, projectId, settings } = yield* requireCaller();
        const { iso, today } = yield* nowParts;
        const resolved = resolveTaskHome(input, today);
        if (typeof resolved === "string") {
          return yield* new AgentToolFailedError({ detail: resolved });
        }
        const home = withReminder(resolved ?? taskHomeOf(undefined, today), input.reminderTime);
        if (typeof home === "string") return yield* new AgentToolFailedError({ detail: home });
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const taskId = TaskId.make(uuid);
        const notes = input.notes !== undefined ? { notes: input.notes } : {};
        // The Assistant adds directly only when it may also edit tasks.
        const direct = settings?.newTasks === "create" && settings.tasks === "edit";
        if (!direct && (input.recurrence !== undefined || input.links !== undefined)) {
          return yield* new AgentToolFailedError({
            detail:
              settings === null
                ? "A proposal cannot repeat or carry links. Propose the plain task; the user sets the rest."
                : "Repeating tasks and links need the Assistant to add tasks directly (Assistant settings: New tasks 'Add directly', Tasks 'Read and edit'). Propose the plain task instead, and tell the user.",
          });
        }
        if (input.recurrence !== undefined && home.kind !== "date") {
          return yield* new AgentToolFailedError({
            detail:
              "A repeating task needs a single day: pass `date` alone, or when: today or tomorrow.",
          });
        }
        if (direct) {
          yield* dispatch(
            {
              type: "task.agent.create",
              commandId: CommandId.make(`mcp-task:${uuid}`),
              taskId,
              actorThreadId: callerId,
              title: input.title,
              ...notes,
              home,
              ...(input.recurrence !== undefined ? { recurrence: input.recurrence } : {}),
              ...(input.links !== undefined ? { links: input.links } : {}),
              createdAt: iso,
            },
            "Could not add the task.",
          );
        } else {
          yield* dispatch(
            {
              type: "task.propose",
              commandId: CommandId.make(`mcp-task:${uuid}`),
              taskId,
              projectId,
              actorThreadId: callerId,
              title: input.title,
              ...notes,
              home,
              ...(input.statusId !== undefined ? { statusId: input.statusId } : {}),
              createdAt: iso,
            },
            "Could not propose the task.",
          );
        }
        const task = yield* findTask(taskId);
        if (task === undefined) {
          return yield* new AgentToolFailedError({ detail: "The task was not saved." });
        }
        const tasks = yield* allTasks;
        return {
          task,
          added: direct,
          proposed: tasks.filter(
            (entry) => isProposedTask(entry) && entry.proposal?.projectId === projectId,
          ).length,
        };
      }),

    cp_task_update: (input: TaskUpdateInput) =>
      Effect.gen(function* () {
        const { callerId, settings } = yield* requireCaller();
        if (settings !== null && settings.tasks !== "edit") {
          return yield* new TaskAccessDeniedError({ detail: ASSISTANT_TASKS_READ_ONLY });
        }
        const stored = yield* findTask(input.taskId);
        if (stored === undefined) {
          return yield* new AgentToolFailedError({ detail: "That task no longer exists." });
        }
        const { iso, today } = yield* nowParts;
        const resolved = resolveTaskHome(input, today);
        if (typeof resolved === "string") {
          return yield* new AgentToolFailedError({ detail: resolved });
        }
        // A move to another day keeps the task's reminder unless told otherwise.
        const keptReminder =
          resolved?.kind === "date" &&
          input.reminderTime === undefined &&
          stored.home.kind === "date" &&
          stored.home.reminderTime !== undefined
            ? stored.home.reminderTime
            : undefined;
        let home: TaskHome | string | undefined = resolved ?? undefined;
        if (input.reminderTime !== undefined || keptReminder !== undefined) {
          home = withReminder(
            resolved ?? stored.home,
            input.reminderTime !== undefined ? input.reminderTime : keptReminder,
          );
        }
        if (typeof home === "string") return yield* new AgentToolFailedError({ detail: home });
        if (
          settings === null &&
          (input.recurrence !== undefined ||
            input.links !== undefined ||
            input.completionPromptDismissed !== undefined)
        ) {
          return yield* new AgentToolFailedError({
            detail:
              "Only the user and the Assistant change a task's repeat, links or completion prompt.",
          });
        }
        // Lucive keeps a repeating task on days: committing it to a period or
        // a backlog needs the repeat stopped first.
        const repeats =
          input.recurrence !== undefined
            ? input.recurrence !== null
            : stored.recurrence !== undefined;
        if (repeats && (home ?? stored.home).kind !== "date") {
          return yield* new AgentToolFailedError({
            detail:
              "A repeating task moves only between days. To commit it to a period or a backlog, stop the repeat first (recurrence: null).",
          });
        }
        const patch: TaskAgentPatch = {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(home !== undefined ? { home } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.recurrence !== undefined ? { recurrence: input.recurrence } : {}),
          ...(input.links !== undefined ? { links: input.links } : {}),
          ...(input.completionPromptDismissed !== undefined
            ? { completionPromptDismissedAt: input.completionPromptDismissed ? iso : null }
            : {}),
        };
        if (Object.keys(patch).length === 0) {
          return yield* new AgentToolFailedError({ detail: "Nothing to change." });
        }
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        yield* dispatch(
          {
            type: "task.agent.update",
            commandId: CommandId.make(`mcp-task:${uuid}`),
            taskId: stored.id,
            actorThreadId: callerId,
            patch,
            createdAt: iso,
          },
          "Could not edit the task.",
        );
        const task = yield* findTask(stored.id);
        if (task === undefined) {
          return yield* new AgentToolFailedError({ detail: "The task was not saved." });
        }
        return { task };
      }),

    cp_task_delete: (input: TaskDeleteInput) =>
      Effect.gen(function* () {
        const { callerId, projectId, settings } = yield* requireCaller();
        if (settings !== null && settings.tasks !== "edit") {
          return yield* new TaskAccessDeniedError({ detail: ASSISTANT_TASKS_READ_ONLY });
        }
        const stored = yield* findTask(input.taskId);
        if (stored === undefined) {
          return yield* new AgentToolFailedError({
            detail:
              "That task no longer exists. If it was deleted, cp_task_restore brings it back.",
          });
        }
        if (
          settings === null &&
          (!isProposedTask(stored) || stored.proposal?.projectId !== projectId)
        ) {
          return yield* new TaskAccessDeniedError({
            detail:
              "A coordinator deletes only its own Project's proposals still waiting on the user (withdrawing them). Ask the user to delete other tasks.",
          });
        }
        const synced =
          (yield* syncedTaskIds).has(stored.id) || stored.importSource?.kind === "lucive";
        const { iso } = yield* nowParts;
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const before = new Set((yield* allTasks).map((task) => task.id as string));
        yield* dispatch(
          {
            type: "task.agent.delete",
            commandId: CommandId.make(`mcp-task:${uuid}`),
            taskId: stored.id,
            actorThreadId: callerId,
            ...(input.scope !== undefined ? { scope: input.scope } : {}),
            createdAt: iso,
          },
          "Could not delete the task.",
        );
        const next = (yield* allTasks).find((task) => !before.has(task.id));
        return {
          taskId: stored.id,
          title: stored.title,
          synced,
          ...(isProposedTask(stored) ? { withdrawn: true } : {}),
          ...(next !== undefined ? { next } : {}),
        };
      }),

    cp_task_restore: (input: TaskRestoreInput) =>
      Effect.gen(function* () {
        const { callerId } = yield* requireAssistantEditor();
        const { iso } = yield* nowParts;
        const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const commandId = CommandId.make(`mcp-task:${uuid}`);
        const stored = yield* findTask(input.taskId);
        if (stored !== undefined) {
          if (stored.status !== "cancelled") {
            return yield* new AgentToolFailedError({
              detail:
                stored.status === "completed"
                  ? "That task is completed, not deleted or cancelled. Reopen it with cp_task_update status todo."
                  : "That task is already on the list.",
            });
          }
          yield* dispatch(
            {
              type: "task.agent.update",
              commandId,
              taskId: stored.id,
              actorThreadId: callerId,
              patch: { status: "todo" },
              createdAt: iso,
            },
            "Could not restore the task.",
          );
          const task = yield* findTask(stored.id);
          if (task === undefined) {
            return yield* new AgentToolFailedError({ detail: "The task was not saved." });
          }
          return { task, restored: "cancelled" as const };
        }
        const record = yield* lastRecord(input.taskId);
        if (record === null) {
          return yield* new AgentToolFailedError({ detail: "There is no task with that id." });
        }
        yield* dispatch(
          {
            type: "task.agent.restore",
            commandId,
            taskId: record.id,
            actorThreadId: callerId,
            task: record,
            createdAt: iso,
          },
          "Could not restore the task.",
        );
        const task = yield* findTask(record.id);
        if (task === undefined) {
          return yield* new AgentToolFailedError({ detail: "The task was not saved." });
        }
        return { task, restored: "deleted" as const };
      }),

    cp_task_reorder: (input: TaskReorderInput) =>
      Effect.gen(function* () {
        const { callerId } = yield* requireAssistantEditor();
        const anchors = [input.beforeTaskId, input.afterTaskId].filter((id) => id !== undefined);
        const single = input.taskId !== undefined;
        const homeGiven =
          input.when !== undefined || input.date !== undefined || input.period !== undefined;
        if (homeGiven !== (input.position !== undefined)) {
          return yield* new AgentToolFailedError({
            detail: "`position` goes with a home (`when`, or `date` with optional `period`).",
          });
        }
        if (homeGiven && (!single || anchors.length > 0)) {
          return yield* new AgentToolFailedError({
            detail:
              "A home with `position` goes with `taskId` alone, without an anchor or `orderedTaskIds`.",
          });
        }
        if (
          single === (input.orderedTaskIds !== undefined) ||
          (single && !homeGiven && anchors.length !== 1)
        ) {
          return yield* new AgentToolFailedError({
            detail:
              "Give `taskId` with exactly one of `beforeTaskId` or `afterTaskId` (or a home with `position`), or `orderedTaskIds` alone.",
          });
        }
        if (!single && anchors.length > 0) {
          return yield* new AgentToolFailedError({
            detail: "`orderedTaskIds` goes alone, without `beforeTaskId` or `afterTaskId`.",
          });
        }
        const named = single ? [input.taskId!, ...anchors.slice(0, 1)] : [...input.orderedTaskIds!];
        if (named.length === 0) {
          return yield* new AgentToolFailedError({ detail: "Name at least one task." });
        }
        if (new Set(named).size !== named.length) {
          return yield* new AgentToolFailedError({ detail: "Each task may appear only once." });
        }
        let tasks = yield* allTasks;
        let byId = new Map(tasks.map((task) => [task.id as string, task]));
        const missing = named.find((id) => byId.get(id) === undefined);
        if (missing !== undefined) {
          return yield* new AgentToolFailedError({ detail: `There is no task '${missing}'.` });
        }
        const closed = named.map((id) => byId.get(id)!).find((task) => task.status !== "todo");
        if (closed !== undefined) {
          return yield* new AgentToolFailedError({
            detail: `'${closed.title}' is ${closed.status}; only open tasks are ordered.`,
          });
        }
        const waiting = named.map((id) => byId.get(id)!).find((task) => isProposedTask(task));
        if (waiting !== undefined) {
          return yield* new AgentToolFailedError({
            detail: `'${waiting.title}' is still a proposal; it has a place once it is added.`,
          });
        }
        const { iso, today } = yield* nowParts;
        // A single task may first move to another list: its anchor's, or the home given.
        if (single) {
          const moved = byId.get(input.taskId!)!;
          let target: TaskHome | null = null;
          if (homeGiven) {
            const resolved = resolveTaskHome(input, today);
            if (typeof resolved === "string") {
              return yield* new AgentToolFailedError({ detail: resolved });
            }
            target = resolved;
          } else {
            const anchor = byId.get(anchors[0]!)!;
            if (taskListKey(anchor.home) !== taskListKey(moved.home)) target = anchor.home;
          }
          if (target !== null && taskListKey(target) !== taskListKey(moved.home)) {
            // Like a drag between lists, a day keeps the moved task's reminder.
            let home: TaskHome = target;
            if (home.kind === "date") {
              const { reminderTime: _anchorReminder, ...day } = home;
              home =
                moved.home.kind === "date" && moved.home.reminderTime !== undefined
                  ? { ...day, reminderTime: moved.home.reminderTime }
                  : day;
            }
            if (moved.recurrence !== undefined && home.kind !== "date") {
              return yield* new AgentToolFailedError({
                detail:
                  "A repeating task moves only between days. Stop the repeat first (cp_task_update recurrence: null).",
              });
            }
            const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
            yield* dispatch(
              {
                type: "task.agent.update",
                commandId: CommandId.make(`mcp-task:${uuid}`),
                taskId: moved.id,
                actorThreadId: callerId,
                patch: { home },
                createdAt: iso,
              },
              "Could not move the task.",
            );
            tasks = yield* allTasks;
            byId = new Map(tasks.map((task) => [task.id as string, task]));
          }
        }
        const listKey = taskListKey(byId.get(named[0]!)!.home);
        const outside = named
          .map((id) => byId.get(id)!)
          .find((t) => taskListKey(t.home) !== listKey);
        if (outside !== undefined) {
          return yield* new AgentToolFailedError({
            detail: `'${outside.title}' is in another list. Move tasks one at a time with \`taskId\` and an anchor, or with cp_task_update, then order them.`,
          });
        }
        const list = tasks
          .filter(
            (task) =>
              task.status === "todo" && !isProposedTask(task) && taskListKey(task.home) === listKey,
          )
          .toSorted(compareTaskOrder);
        let wanted: string[];
        if (single) {
          const movedId = input.taskId!;
          const ids = list.map((task) => task.id as string).filter((id) => id !== movedId);
          if (homeGiven) {
            if (input.position === "top") ids.unshift(movedId);
            else ids.push(movedId);
          } else {
            const anchorId = anchors[0]!;
            ids.splice(
              ids.indexOf(anchorId) + (input.afterTaskId !== undefined ? 1 : 0),
              0,
              movedId,
            );
          }
          wanted = ids;
        } else {
          const first = new Set<string>(named);
          wanted = [...named, ...list.map((t) => t.id as string).filter((id) => !first.has(id))];
        }
        for (const assignment of planTaskReorder(list, wanted)) {
          const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
          yield* dispatch(
            {
              type: "task.agent.update",
              commandId: CommandId.make(`mcp-task:${uuid}`),
              taskId: TaskId.make(assignment.id),
              actorThreadId: callerId,
              patch: { orderKey: assignment.orderKey as TaskOrderKey },
              createdAt: iso,
            },
            "Could not reorder the tasks.",
          );
        }
        const after = yield* allTasks;
        return {
          tasks: after
            .filter(
              (task) =>
                task.status === "todo" &&
                !isProposedTask(task) &&
                taskListKey(task.home) === listKey,
            )
            .toSorted(compareTaskOrder),
        };
      }),

    cp_task_intent_set: (input: TaskIntentSetInput) =>
      Effect.gen(function* () {
        yield* requireAssistantEditor();
        const { iso, today } = yield* nowParts;
        if ((input.when === undefined) === (input.date === undefined)) {
          return yield* new AgentToolFailedError({ detail: "Give either `when` or `date`." });
        }
        if (input.date !== undefined && !isTaskLocalDate(input.date)) {
          return yield* new AgentToolFailedError({
            detail: `'${input.date}' is not a real date. Use YYYY-MM-DD, such as 2026-11-16.`,
          });
        }
        if (input.text.trim().length > TASK_INTENT_MAX) {
          return yield* new AgentToolFailedError({
            detail: `An intent is at most ${TASK_INTENT_MAX} characters.`,
          });
        }
        const current = taskPeriodFor(input.horizon, input.date ?? today);
        const period =
          input.when === "next"
            ? taskPeriodFor(input.horizon, addTaskDays(current.endsOn, 1))
            : current;
        const stored = (yield* readIntents).find(
          (intent) => intent.horizon === input.horizon && intent.startsOn === period.startsOn,
        );
        const text = input.text.trim();
        if (text !== (stored?.text ?? "")) {
          const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
          yield* dispatch(
            {
              type: "task.intent.set",
              commandId: CommandId.make(`mcp-task:${uuid}`),
              horizon: input.horizon,
              startsOn: period.startsOn,
              text,
              createdAt: iso,
            },
            "Could not save the intent.",
          );
        }
        const intent = (yield* readIntents).find(
          (entry) => entry.horizon === input.horizon && entry.startsOn === period.startsOn,
        );
        return {
          horizon: input.horizon,
          startsOn: period.startsOn,
          endsOn: period.endsOn,
          intent: intent ?? null,
        };
      }),
  };

  /** Runs `one` for each task, collecting a result per task instead of stopping at a failure. */
  const eachTask = <E extends { readonly message: string }, R>(
    taskIds: ReadonlyArray<string>,
    one: (taskId: string) => Effect.Effect<Task | null, E, R>,
  ) =>
    Effect.gen(function* () {
      const results: TaskBulkItem[] = [];
      for (const taskId of taskIds) {
        const title = (yield* findTask(taskId))?.title;
        const outcome = yield* Effect.result(one(taskId));
        results.push({
          taskId: TaskId.make(taskId),
          ...(title !== undefined ? { title } : {}),
          ...(Result.isSuccess(outcome)
            ? { ok: true, task: outcome.success }
            : { ok: false, error: outcome.failure.message }),
        });
      }
      const succeeded = results.filter((entry) => entry.ok).length;
      return { results, succeeded, failed: results.length - succeeded };
    });

  const uniqueIds = (ids: ReadonlyArray<string>) =>
    new Set(ids).size === ids.length
      ? Effect.succeed(ids)
      : Effect.fail(new AgentToolFailedError({ detail: "Each task may appear only once." }));

  return {
    ...handlers,

    cp_task_bulk: (input: TaskBulkInput) =>
      Effect.gen(function* () {
        const { settings } = yield* requireCaller();
        if (settings === null && input.action !== "move" && input.action !== "delete") {
          return yield* new TaskAccessDeniedError({
            detail:
              "A coordinator may only move or withdraw (delete) its own Project's waiting proposals. Ask the user to change the others.",
          });
        }
        if (settings !== null && settings.tasks !== "edit") {
          return yield* new TaskAccessDeniedError({ detail: ASSISTANT_TASKS_READ_ONLY });
        }
        const homeGiven =
          input.when !== undefined || input.date !== undefined || input.period !== undefined;
        if (input.action === "move" && !homeGiven && input.reminderTime === undefined) {
          return yield* new AgentToolFailedError({
            detail: "move needs a home: `when`, or `date` with optional `period`.",
          });
        }
        if (input.action !== "move" && (homeGiven || input.reminderTime !== undefined)) {
          return yield* new AgentToolFailedError({
            detail: "A home or reminder goes only with action move.",
          });
        }
        if (input.scope !== undefined && input.action !== "delete") {
          return yield* new AgentToolFailedError({ detail: "`scope` goes only with delete." });
        }
        const taskIds = yield* uniqueIds(input.taskIds);
        const status = { complete: "completed", cancel: "cancelled", reopen: "todo" } as const;
        return yield* eachTask(taskIds, (taskId) => {
          const id = TaskId.make(taskId);
          switch (input.action) {
            case "move":
              return handlers
                .cp_task_update({
                  taskId: id,
                  ...(input.when !== undefined ? { when: input.when } : {}),
                  ...(input.date !== undefined ? { date: input.date } : {}),
                  ...(input.period !== undefined ? { period: input.period } : {}),
                  ...(input.reminderTime !== undefined ? { reminderTime: input.reminderTime } : {}),
                })
                .pipe(Effect.map((result): Task | null => result.task));
            case "complete":
            case "cancel":
            case "reopen":
              return handlers
                .cp_task_update({ taskId: id, status: status[input.action] })
                .pipe(Effect.map((result): Task | null => result.task));
            case "delete":
              return Effect.gen(function* () {
                const stored = yield* findTask(taskId);
                // A scope applies to the repeating tasks among them only.
                const repeats = stored?.recurrence !== undefined && stored.home.kind === "date";
                yield* handlers.cp_task_delete({
                  taskId: id,
                  ...(input.scope !== undefined && repeats ? { scope: input.scope } : {}),
                });
                return null;
              });
            case "restore":
              return handlers
                .cp_task_restore({ taskId: id })
                .pipe(Effect.map((result): Task | null => result.task));
          }
        });
      }),

    cp_task_proposal_respond: (input: TaskProposalRespondInput) =>
      Effect.gen(function* () {
        const { callerId } = yield* requireAssistantEditor(
          "Only the user (or the Assistant, when the user asks) adds or dismisses a proposal. To take back one of your own, withdraw it with cp_task_delete.",
        );
        if ((input.taskIds === undefined) === (input.projectId === undefined)) {
          return yield* new AgentToolFailedError({
            detail: "Give either `taskIds` or `projectId`.",
          });
        }
        const { iso, today } = yield* nowParts;
        const resolved = resolveTaskHome(input, today);
        if (typeof resolved === "string") {
          return yield* new AgentToolFailedError({ detail: resolved });
        }
        if (!input.accept && (resolved !== null || input.reminderTime !== undefined)) {
          return yield* new AgentToolFailedError({
            detail: "A home or reminder goes only with accept: true.",
          });
        }
        const taskIds =
          input.taskIds !== undefined
            ? yield* uniqueIds(input.taskIds)
            : (yield* allTasks)
                .filter(
                  (task) => isProposedTask(task) && task.proposal?.projectId === input.projectId,
                )
                .toSorted((left, right) =>
                  left.proposal!.proposedAt.localeCompare(right.proposal!.proposedAt),
                )
                .map((task) => task.id as string);
        if (taskIds.length === 0) {
          return yield* new AgentToolFailedError({
            detail: "That Project has no proposals waiting.",
          });
        }
        return yield* eachTask(taskIds, (taskId) =>
          Effect.gen(function* () {
            const stored = yield* findTask(taskId);
            if (stored === undefined || !isProposedTask(stored)) {
              return yield* new AgentToolFailedError({
                detail: "That is not a proposal waiting on the user.",
              });
            }
            let home: TaskHome | string | undefined = resolved ?? undefined;
            if (input.reminderTime !== undefined) {
              home = withReminder(resolved ?? stored.home, input.reminderTime);
            }
            if (typeof home === "string") return yield* new AgentToolFailedError({ detail: home });
            const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
            yield* dispatch(
              {
                type: "task.agent.respond",
                commandId: CommandId.make(`mcp-task:${uuid}`),
                taskId: stored.id,
                actorThreadId: callerId,
                accept: input.accept,
                ...(home !== undefined ? { patch: { home } } : {}),
                createdAt: iso,
              },
              input.accept ? "Could not add the proposal." : "Could not dismiss the proposal.",
            );
            if (!input.accept) return null;
            const task = yield* findTask(stored.id);
            if (task === undefined) {
              return yield* new AgentToolFailedError({ detail: "The task was not saved." });
            }
            return task;
          }),
        );
      }),

    cp_task_handoff: (input: TaskHandoffInput) =>
      Effect.gen(function* () {
        const { callerId } = yield* requireAssistantEditor();
        if (input.projectId !== undefined && input.to !== "coordinator") {
          return yield* new AgentToolFailedError({
            detail: "`projectId` goes with to: coordinator.",
          });
        }
        if ((input.threadId !== undefined) !== (input.to === "agent")) {
          return yield* new AgentToolFailedError({
            detail: "to: agent needs `threadId`, and `threadId` goes only with it.",
          });
        }
        const taskIds = yield* uniqueIds(input.taskIds);
        const model = yield* snapshots.getCommandReadModel().pipe(Effect.mapError(readFailed));
        const liveProjects = model.projects.filter((project) => project.deletedAt === null);
        const { iso } = yield* nowParts;
        /** The thread `to` names for this task, or why there is none. */
        const targetFor = (task: Task | undefined): TaskHandoff | null | string => {
          switch (input.to) {
            case "none":
              return null;
            case "assistant": {
              const threadId =
                findGlobalAssistantProject(liveProjects)?.assistant?.coordinatorThreadId;
              return threadId == null
                ? "The user has no Assistant to hand tasks to."
                : { kind: "coordinator", threadId, at: iso };
            }
            case "coordinator": {
              const projectId = input.projectId ?? task?.links?.projectId;
              if (projectId === undefined) {
                return "That task has no Project; give `projectId`.";
              }
              const threadId = liveProjects.find((project) => project.id === projectId)?.assistant
                ?.coordinatorThreadId;
              return threadId == null
                ? "That Project has no coordinator."
                : { kind: "coordinator", threadId, at: iso };
            }
            case "agent":
              return { kind: "agent", threadId: input.threadId!, at: iso };
          }
        };
        const outcome = yield* eachTask(taskIds, (taskId) =>
          Effect.gen(function* () {
            const stored = yield* findTask(taskId);
            if (stored === undefined) {
              return yield* new AgentToolFailedError({ detail: "That task no longer exists." });
            }
            const handoff = targetFor(stored);
            if (typeof handoff === "string") {
              return yield* new AgentToolFailedError({ detail: handoff });
            }
            if (handoff === null && stored.handoff === undefined) return stored;
            const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
            yield* dispatch(
              {
                type: "task.agent.handoff",
                commandId: CommandId.make(`mcp-task:${uuid}`),
                taskId: stored.id,
                actorThreadId: callerId,
                handoff,
                createdAt: iso,
              },
              "Could not hand the task off.",
            );
            const task = yield* findTask(stored.id);
            if (task === undefined) {
              return yield* new AgentToolFailedError({ detail: "The task was not saved." });
            }
            return task;
          }),
        );
        // Then each receiving thread gets one handoff message with its tasks,
        // queued until it is idle, unless the caller is that thread itself.
        const byThread = new Map<string, TaskId[]>();
        for (const entry of outcome.results) {
          const threadId = entry.ok ? entry.task?.handoff?.threadId : undefined;
          if (threadId === undefined || threadId === callerId) continue;
          byThread.set(threadId, [...(byThread.get(threadId) ?? []), entry.taskId]);
        }
        const delivered: ThreadId[] = [];
        for (const [threadId, ids] of byThread) {
          const last = (yield* findTask(ids.at(-1)!))?.handoff;
          if (last === undefined) continue;
          const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
          yield* dispatch(
            {
              type: "task.agent.handoff",
              commandId: CommandId.make(taskHandoffDeliveryId(threadId, uuid)),
              taskId: ids.at(-1)!,
              actorThreadId: callerId,
              handoff: last,
              deliver: { taskIds: ids },
              createdAt: iso,
            },
            "The tasks were handed off, but the handoff message was not sent.",
          );
          delivered.push(ThreadId.make(threadId));
        }
        return { ...outcome, ...(delivered.length > 0 ? { delivered } : {}) };
      }),
  } satisfies TaskHandlers;
});
