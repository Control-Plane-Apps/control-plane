/**
 * Where proposals show and how a chat sums up the tasks it proposed: the
 * range each proposal is homed in, the `cp_task_propose` calls of one turn
 * grouped into one block, and that block's live state from the task store.
 * Pure, shared by web and mobile. Fork-owned.
 */
import {
  addTaskDays,
  isProposedTask,
  taskPeriodFor,
  type Task,
  type TaskHome,
} from "@t3tools/contracts";

import {
  formatTaskHome,
  proposedTasks,
  type TaskBacklogFilter,
  type TaskView,
} from "./taskViews.ts";

/** Days ahead the Upcoming view lists, matching `upcomingTasks`. */
const UPCOMING_DAYS = 7;

/**
 * The range a home belongs to: today or overdue in Today, the current
 * week / month / year commitment in its range, the next week of days in
 * Upcoming, and everything else (backlogs, later periods, far dates) in All
 * tasks, so a proposal always has one place to wait.
 */
export function taskViewForHome(home: TaskHome, today: string): TaskView {
  switch (home.kind) {
    case "date":
      if (home.date <= today) return "today";
      return home.date <= addTaskDays(today, UPCOMING_DAYS) ? "upcoming" : "all";
    case "period":
      return taskPeriodFor(home.horizon, today).startsOn === home.startsOn ? home.horizon : "all";
    case "backlog":
      return "all";
  }
}

/**
 * The proposals one range shows at the top of its list. All tasks narrows to
 * a backlog when filtered; Recurring and Completed show none.
 */
export function proposedTasksForView(
  tasks: ReadonlyArray<Task>,
  view: TaskView,
  today: string,
  filter: TaskBacklogFilter = "all",
): Task[] {
  return proposedTasks(tasks).filter((task) => {
    if (taskViewForHome(task.home, today) !== view) return false;
    if (view !== "all" || filter === "all") return true;
    if (filter === "recurring" || filter === "completed") return false;
    return task.home.kind === "backlog" && task.home.horizon === filter;
  });
}

/** The proposals homed on one day, for its Upcoming card. */
export function proposedTasksOnDate(tasks: ReadonlyArray<Task>, date: string): Task[] {
  return proposedTasks(tasks).filter(
    (task) => task.home.kind === "date" && task.home.date === date,
  );
}

/** "Add both" for two, else "Add all". */
export function addAllProposalsLabel(count: number): string {
  return count === 2 ? "Add both" : "Add all";
}

// The cp_task_propose calls a chat made.

export interface TaskProposeCall {
  /** The provider's tool call id, else the activity id. */
  readonly callId: string;
  /** The task the call created, from its result; null until it returns. */
  readonly taskId: string | null;
  /** The `title` argument, for matching when the result has no id. */
  readonly title: string | null;
  readonly createdAt: string;
  readonly status: "inProgress" | "completed" | "failed";
}

/** The fields of a work-log entry (web or mobile) a call is read from. */
export interface TaskProposeCallSource {
  readonly id: string;
  readonly createdAt: string;
  readonly toolCallId?: string | undefined;
  readonly toolData?: unknown;
  readonly toolTitle?: string | undefined;
  readonly label?: string | undefined;
  readonly toolLifecycleStatus?: string | undefined;
}

const CPLANE_PREFIX =
  /^(?:mcp__(?:cplane|t3-code|t3_code|t3code)__|(?:cplane|t3-code|t3_code|t3code)(?:[.:/_]|\s*·\s*))/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isTaskProposeName(value: unknown): boolean {
  const name = nonEmpty(value);
  return name !== null && name.replace(CPLANE_PREFIX, "") === "cp_task_propose";
}

function toolNameMatches(source: TaskProposeCallSource): boolean {
  const data = asRecord(source.toolData);
  if (data !== null) {
    if (typeof data.server === "string" && typeof data.tool === "string") {
      return (
        isTaskProposeName(data.tool) && /^(?:cplane|t3-code|t3_code|t3code)$/i.test(data.server)
      );
    }
    if (typeof data.toolName === "string") return isTaskProposeName(data.toolName);
  }
  return isTaskProposeName(source.toolTitle) || isTaskProposeName(source.label);
}

function resultText(value: unknown): string | null {
  const direct = nonEmpty(value);
  if (direct !== null) return direct;
  const record = asRecord(value);
  const content = record?.content ?? (Array.isArray(value) ? value : undefined);
  const text = nonEmpty(content);
  if (text !== null) return text;
  if (!Array.isArray(content)) return null;
  const chunks = content.flatMap((block) => {
    const chunk = nonEmpty(block) ?? nonEmpty(asRecord(block)?.text);
    return chunk === null ? [] : [chunk];
  });
  return chunks.length > 0 ? chunks.join("\n") : null;
}

// The server keeps only the first 84 characters of a result. The encoded
// result starts `{"task":{"id":"<uuid>"`, so the id survives; it is matched
// rather than parsed because the JSON is cut short.
const RESULT_TASK_ID = /^\s*\{\s*"task"\s*:\s*\{\s*"id"\s*:\s*"([^"\\]+)"/;

function taskIdFromToolData(data: Record<string, unknown> | null): string | null {
  const item = asRecord(data?.item);
  const state = asRecord(data?.state);
  for (const result of [item?.result, data?.result, state?.output, data?.rawOutput]) {
    const record = asRecord(result);
    const structured = asRecord(asRecord(record?.structuredContent)?.task);
    const id = nonEmpty(structured?.id) ?? nonEmpty(asRecord(record?.task)?.id);
    if (id !== null) return id;
    const text = resultText(result);
    const match = text === null ? null : RESULT_TASK_ID.exec(text);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/** The `cp_task_propose` call an entry records, or null for any other entry. */
export function taskProposeCallOf(source: TaskProposeCallSource): TaskProposeCall | null {
  if (!toolNameMatches(source)) return null;
  const data = asRecord(source.toolData);
  const input =
    asRecord(data?.arguments) ??
    asRecord(data?.input) ??
    asRecord(data?.rawInput) ??
    asRecord(asRecord(data?.state)?.input);
  const raw = source.toolLifecycleStatus;
  const status =
    raw === "failed" || raw === "declined" || raw === "stopped"
      ? "failed"
      : raw === "completed"
        ? "completed"
        : "inProgress";
  return {
    callId:
      source.toolCallId ??
      nonEmpty(data?.toolCallId) ??
      (typeof data?.tool === "string" ? nonEmpty(data.id) : null) ??
      source.id,
    taskId: taskIdFromToolData(data),
    title: nonEmpty(input?.title),
    createdAt: source.createdAt,
    status,
  };
}

/** One turn's proposals, drawn as one block where the first call was made. */
export interface TaskProposalBlock {
  /** The first call's entry id, the block's anchor. */
  readonly id: string;
  readonly turnId: string | null;
  readonly createdAt: string;
  readonly calls: ReadonlyArray<TaskProposeCall>;
}

/** Folds a later lifecycle update of the same call into the earlier one. */
export function mergeTaskProposeCalls(
  previous: TaskProposeCall,
  next: TaskProposeCall,
): TaskProposeCall {
  return {
    callId: previous.callId,
    taskId: next.taskId ?? previous.taskId,
    title: next.title ?? previous.title,
    createdAt: previous.createdAt,
    status: next.status === "inProgress" ? previous.status : next.status,
  };
}

/** Adds a call to a block, merging it into the same call's earlier update. */
export function withTaskProposeCall(
  calls: ReadonlyArray<TaskProposeCall>,
  call: TaskProposeCall,
): TaskProposeCall[] {
  const index = calls.findIndex((entry) => entry.callId === call.callId);
  if (index === -1) return [...calls, call];
  return calls.map((entry, at) => (at === index ? mergeTaskProposeCalls(entry, call) : entry));
}

/**
 * Groups calls by turn, in the order they appear: one block per turn, at the
 * first call. Entries that are not `cp_task_propose` calls are skipped.
 */
export function groupTaskProposeCalls(
  entries: ReadonlyArray<TaskProposeCallSource & { readonly turnId?: string | null | undefined }>,
): TaskProposalBlock[] {
  const blocks: TaskProposalBlock[] = [];
  const byKey = new Map<string, number>();
  for (const entry of entries) {
    const call = taskProposeCallOf(entry);
    if (call === null) continue;
    const turnId = entry.turnId ?? null;
    const key = turnId ?? `call:${call.callId}`;
    const index = byKey.get(key);
    if (index === undefined) {
      byKey.set(key, blocks.length);
      blocks.push({ id: entry.id, turnId, createdAt: entry.createdAt, calls: [call] });
      continue;
    }
    const block = blocks[index]!;
    blocks[index] = { ...block, calls: withTaskProposeCall(block.calls, call) };
  }
  return blocks;
}

/** How long after a call its proposal may be stamped, for the title fallback. */
const MATCH_WINDOW_MS = 5 * 60 * 1000;

export interface ResolvedTaskProposalBlock {
  /** The tasks the block's calls created that still exist, in call order. */
  readonly tasks: ReadonlyArray<Task>;
  /** Calls that returned a task the store no longer has: dismissed. */
  readonly dismissed: number;
  /** Calls still running or not yet matched to a task. */
  readonly pending: number;
  /** Calls that failed: nothing was proposed. */
  readonly failed: number;
}

/**
 * Finds the tasks a block's calls created: by the id in each call's result,
 * else (an older result, or one still running) by the proposal this thread
 * stamped with the same title within a few minutes of the call.
 */
export function resolveTaskProposalBlock(
  block: Pick<TaskProposalBlock, "calls">,
  tasks: ReadonlyArray<Task>,
  threadId: string,
): ResolvedTaskProposalBlock {
  const byId = new Map(tasks.map((task) => [task.id as string, task]));
  const used = new Set<string>(
    block.calls.flatMap((call) => (call.taskId !== null ? [call.taskId] : [])),
  );
  const found: Task[] = [];
  let dismissed = 0;
  let pending = 0;
  let failed = 0;
  for (const call of block.calls) {
    if (call.status === "failed") {
      failed += 1;
      continue;
    }
    if (call.taskId !== null) {
      const task = byId.get(call.taskId);
      if (task !== undefined) found.push(task);
      else if (call.status === "completed") dismissed += 1;
      else pending += 1;
      continue;
    }
    const at = Date.parse(call.createdAt);
    const match = tasks.find((task) => {
      if (used.has(task.id) || call.title === null || task.title !== call.title) return false;
      if (task.proposal?.threadId !== threadId) return false;
      const stamped = Date.parse(task.proposal.proposedAt);
      return stamped >= at - 1000 && stamped <= at + MATCH_WINDOW_MS;
    });
    if (match !== undefined) {
      used.add(match.id);
      found.push(match);
    } else if (call.status === "completed") {
      dismissed += 1;
    } else {
      pending += 1;
    }
  }
  return { tasks: found, dismissed, pending, failed };
}

export interface TaskProposalBlockSummary {
  /** "Proposed 6 tasks · This week" */
  readonly headline: string;
  /** The first few tasks, in call order. */
  readonly items: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  /** Tasks beyond `items`. */
  readonly moreCount: number;
  /** "6 proposed · 4 added", "All added", "All dismissed". */
  readonly status: string;
  readonly waiting: number;
  readonly added: number;
  readonly dismissed: number;
  /** The range to open, where most of the block's tasks live; null when none remain. */
  readonly view: TaskView | null;
  /** The tasks to highlight there. */
  readonly highlightIds: ReadonlyArray<string>;
}

function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

/** "This week" for one shared home, "Today" for overdue days, else "across ranges". */
function rangeLabel(tasks: ReadonlyArray<Task>, today: string): string | null {
  if (tasks.length === 0) return null;
  const labels = new Set(
    tasks.map((task) =>
      task.home.kind === "date" && task.home.date <= today
        ? "Today"
        : formatTaskHome(task.home, today),
    ),
  );
  return labels.size === 1 ? [...labels][0]! : "across ranges";
}

function mostCommonView(tasks: ReadonlyArray<Task>, today: string): TaskView | null {
  const counts = new Map<TaskView, number>();
  for (const task of tasks) {
    const view = taskViewForHome(task.home, today);
    counts.set(view, (counts.get(view) ?? 0) + 1);
  }
  let best: TaskView | null = null;
  let bestCount = 0;
  for (const [view, count] of counts) {
    if (count > bestCount) {
      best = view;
      bestCount = count;
    }
  }
  return best;
}

/** The block's text and link, live from the task store. */
export function summarizeTaskProposalBlock(
  resolved: ResolvedTaskProposalBlock,
  today: string,
  maxTitles = 3,
): TaskProposalBlockSummary {
  const { tasks, dismissed, pending, failed } = resolved;
  const open = tasks.filter((task) => task.status === "todo" || task.status === "completed");
  const waiting = open.filter((task) => isProposedTask(task)).length + pending;
  const added = open.length - open.filter((task) => isProposedTask(task)).length;
  const total = waiting + added + dismissed;
  // The Assistant adding directly leaves no proposal behind.
  const direct =
    tasks.length > 0 && dismissed === 0 && pending === 0 && tasks.every((task) => !task.proposal);
  const range = rangeLabel(open, today);
  const headline =
    total === 0 && failed > 0
      ? `Could not propose ${plural(failed, "task")}`
      : `${direct ? "Added" : "Proposed"} ${plural(total, "task")}${
          range !== null ? ` · ${range}` : ""
        }`;
  const status =
    direct || total === 0
      ? ""
      : total > 0 && added === total
        ? "All added"
        : total > 0 && dismissed === total
          ? "All dismissed"
          : waiting === 0
            ? [added > 0 ? `${added} added` : null, dismissed > 0 ? `${dismissed} dismissed` : null]
                .filter((part) => part !== null)
                .join(" · ")
            : [
                `${total} proposed`,
                added > 0 ? `${added} added` : null,
                dismissed > 0 ? `${dismissed} dismissed` : null,
              ]
                .filter((part) => part !== null)
                .join(" · ");
  const items = open
    .slice(0, maxTitles)
    .map((task) => ({ id: task.id as string, title: task.title }));
  return {
    headline,
    items,
    moreCount: Math.max(0, open.length - items.length),
    status,
    waiting,
    added,
    dismissed,
    view: mostCommonView(open, today),
    highlightIds: open.map((task) => task.id as string),
  };
}

/** `highlight` search value: ids joined by commas. */
export function encodeTaskHighlight(ids: ReadonlyArray<string>): string {
  return ids.join(",");
}

export function decodeTaskHighlight(value: string | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  return value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

// Reading calls straight from a thread's activities (mobile builds its feed
// separately from web's work log).

/** The activity fields a call is read from. */
export interface TaskProposeActivity {
  readonly id: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly summary: string;
  readonly turnId: string | null;
  readonly payload: unknown;
}

function lifecycleStatusOf(kind: string, payload: Record<string, unknown> | null): string {
  const status = nonEmpty(payload?.status)?.toLowerCase().replace(/[_-]/g, "");
  if (status === "failed" || status === "error") return "failed";
  if (status === "declined" || status === "stopped" || status === "cancelled") return "failed";
  if (status === "completed" || status === "success") return "completed";
  return kind === "tool.completed" ? "completed" : "inProgress";
}

/** The call-source view of one tool activity, or null for other activities. */
export function taskProposeSourceOfActivity(
  activity: TaskProposeActivity,
): (TaskProposeCallSource & { readonly turnId: string | null }) | null {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") return null;
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  const toolData = typeof data?.toolName === "string" ? (data.item ?? data) : data?.item;
  const toolCallId = nonEmpty(payload?.toolCallId) ?? nonEmpty(data?.toolCallId);
  const title = nonEmpty(payload?.title);
  return {
    id: activity.id,
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    ...(toolCallId !== null ? { toolCallId } : {}),
    ...(toolData !== undefined ? { toolData } : {}),
    ...(title !== null ? { toolTitle: title } : {}),
    label: activity.summary,
    toolLifecycleStatus: lifecycleStatusOf(activity.kind, payload),
  };
}

/** A thread's proposal blocks, from its activities in order. */
export function taskProposalBlocksFromActivities(
  activities: ReadonlyArray<TaskProposeActivity>,
): TaskProposalBlock[] {
  return groupTaskProposeCalls(
    activities.flatMap((activity) => {
      const source = taskProposeSourceOfActivity(activity);
      return source === null ? [] : [source];
    }),
  );
}

export interface TaskProposalAnchorEntry {
  readonly id: string;
  readonly type: string;
  readonly createdAt: string;
  readonly message?: { readonly role: string } | undefined;
}

/**
 * Where each block draws in a feed that shows accessories under its rows:
 * under the last reply of the turn that proposed (the reply survives a
 * folded turn), else, mid-turn, under the newest row.
 */
export function anchorTaskProposalBlocks<B extends Pick<TaskProposalBlock, "createdAt">>(
  feed: ReadonlyArray<TaskProposalAnchorEntry>,
  blocks: ReadonlyArray<B>,
): ReadonlyMap<string, ReadonlyArray<B>> {
  const anchored = new Map<string, B[]>();
  const last = feed.at(-1);
  if (last === undefined) return anchored;
  for (const block of blocks) {
    let anchor: TaskProposalAnchorEntry | undefined;
    for (const entry of feed) {
      if (entry.createdAt < block.createdAt || entry.type !== "message") continue;
      const role = entry.message?.role;
      if (role === "user") break;
      if (role === "assistant") anchor = entry;
    }
    const target = anchor ?? last;
    const list = anchored.get(target.id) ?? [];
    list.push(block);
    anchored.set(target.id, list);
  }
  return anchored;
}
