/**
 * Pure task view logic shared by web and mobile: which tasks each view
 * shows, how a task's home reads, where a handed-off task stands, and the
 * quick-add parser. Fork-owned.
 */
import {
  addTaskDays,
  compareTaskOrder,
  countStatusesNeedingUser,
  isProposedTask,
  taskPeriodFor,
  taskDaysBetween,
  taskWeekday,
  type ProjectStatus,
  type Task,
  type TaskHome,
  type TaskHorizon,
  type TaskIntent,
  type TaskRecurrence,
} from "@t3tools/contracts";

export type TaskView = "today" | "week" | "month" | "year" | "upcoming" | "all";
export type TaskBacklogFilter = "all" | "week" | "month" | "year" | "recurring";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function monthIndex(date: string): number {
  return Number(date.slice(5, 7)) - 1;
}
function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10));
}

/** "Friday, November 13" */
export function formatTaskDayTitle(date: string): string {
  return `${WEEKDAYS[taskWeekday(date)]}, ${MONTHS[monthIndex(date)]} ${dayOfMonth(date)}`;
}
/** "Friday" */
export function formatTaskWeekday(date: string): string {
  return WEEKDAYS[taskWeekday(date)]!;
}
/** "November 13" */
export function formatTaskMonthDay(date: string): string {
  return `${MONTHS[monthIndex(date)]} ${dayOfMonth(date)}`;
}
/** "Nov 9" */
export function formatTaskShortDate(date: string): string {
  return `${MONTHS[monthIndex(date)]!.slice(0, 3)} ${dayOfMonth(date)}`;
}
/** "Nov 9 to 15", or "Nov 30 to Dec 6" across months. */
export function formatTaskRange(startsOn: string, endsOn: string): string {
  const end =
    monthIndex(startsOn) === monthIndex(endsOn)
      ? String(dayOfMonth(endsOn))
      : formatTaskShortDate(endsOn);
  return `${formatTaskShortDate(startsOn)} to ${end}`;
}
/** "Week of November 9", "November", "2026" */
export function formatTaskPeriodTitle(horizon: TaskHorizon, startsOn: string): string {
  switch (horizon) {
    case "week":
      return `Week of ${formatTaskMonthDay(startsOn)}`;
    case "month":
      return `${MONTHS[monthIndex(startsOn)]} ${startsOn.slice(0, 4)}`;
    case "year":
      return startsOn.slice(0, 4);
  }
}

/** "9:30 AM" from "09:30". */
export function formatTaskTime(time: string): string {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function formatTaskRecurrence(recurrence: TaskRecurrence): string {
  const n = recurrence.interval;
  switch (recurrence.frequency) {
    case "daily":
      return n === 1 ? "Daily" : `Every ${n} days`;
    case "weekly":
      return n === 1 ? "Weekly" : `Every ${n} weeks`;
    case "monthly":
      return n === 1 ? "Monthly" : `Every ${n} months`;
  }
}

/** How a task's home reads on its row, relative to `today`. */
export function formatTaskHome(home: TaskHome, today: string): string {
  switch (home.kind) {
    case "date": {
      if (home.date === today) return "Today";
      if (home.date === addTaskDays(today, -1)) return "Yesterday";
      if (home.date === addTaskDays(today, 1)) return "Tomorrow";
      const diff = taskDaysBetween(today, home.date);
      if (diff > 1 && diff < 7) return WEEKDAYS_SHORT[taskWeekday(home.date)]!;
      return formatTaskShortDate(home.date);
    }
    case "period": {
      const current = taskPeriodFor(home.horizon, today).startsOn === home.startsOn;
      if (current) return `This ${home.horizon}`;
      return home.horizon === "week"
        ? `Week of ${formatTaskShortDate(home.startsOn)}`
        : formatTaskPeriodTitle(home.horizon, home.startsOn);
    }
    case "backlog":
      return home.horizon === null
        ? "General backlog"
        : `${home.horizon[0]!.toUpperCase()}${home.horizon.slice(1)} backlog`;
  }
}

/** Whether the row's home label reads as overdue. */
export function isTaskOverdue(task: Pick<Task, "home" | "status">, today: string): boolean {
  return task.status === "todo" && task.home.kind === "date" && task.home.date < today;
}

/** Proposals, newest first. */
export function proposedTasks(tasks: ReadonlyArray<Task>): Task[] {
  return tasks
    .filter((task) => task.status === "todo" && isProposedTask(task))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function listed(tasks: ReadonlyArray<Task>): Task[] {
  return tasks.filter((task) => !isProposedTask(task));
}

function sorted(tasks: Task[]): Task[] {
  return tasks.sort(compareTaskOrder);
}

/** Open tasks due today or earlier, in the user's order. */
export function todayTasks(tasks: ReadonlyArray<Task>, today: string): Task[] {
  return sorted(
    listed(tasks).filter(
      (task) => task.status === "todo" && task.home.kind === "date" && task.home.date <= today,
    ),
  );
}

/** Tasks completed today that the Today view shows under "Show completed". */
export function completedToday(tasks: ReadonlyArray<Task>, today: string): Task[] {
  return listed(tasks).filter(
    (task) =>
      task.status === "completed" &&
      task.completedAt !== undefined &&
      ((task.home.kind === "date" && task.home.date === today) ||
        task.completedAt.slice(0, 10) === today),
  );
}

/** Open commitments to the current week, month or year. */
export function committedTasks(
  tasks: ReadonlyArray<Task>,
  horizon: TaskHorizon,
  today: string,
): Task[] {
  const { startsOn } = taskPeriodFor(horizon, today);
  return sorted(
    listed(tasks).filter(
      (task) =>
        task.status === "todo" &&
        task.home.kind === "period" &&
        task.home.horizon === horizon &&
        task.home.startsOn === startsOn,
    ),
  );
}

/** Open tasks in one horizon's backlog (or the general backlog for null). */
export function backlogTasks(tasks: ReadonlyArray<Task>, horizon: TaskHorizon | null): Task[] {
  return sorted(
    listed(tasks).filter(
      (task) =>
        task.status === "todo" && task.home.kind === "backlog" && task.home.horizon === horizon,
    ),
  );
}

export interface TaskDayGroup {
  readonly date: string;
  readonly tasks: Task[];
}

/** The next `days` days after today, each with its open tasks. */
export function upcomingTasks(tasks: ReadonlyArray<Task>, today: string, days = 7): TaskDayGroup[] {
  const groups: TaskDayGroup[] = [];
  for (let offset = 1; offset <= days; offset += 1) {
    const date = addTaskDays(today, offset);
    groups.push({
      date,
      tasks: sorted(
        listed(tasks).filter(
          (task) => task.status === "todo" && task.home.kind === "date" && task.home.date === date,
        ),
      ),
    });
  }
  return groups;
}

/** "Tomorrow", "In 2 days" */
export function formatUpcomingOffset(date: string, today: string): string {
  const diff = taskDaysBetween(today, date);
  return diff === 1 ? "Tomorrow" : `In ${diff} days`;
}

function homeRank(home: TaskHome): string {
  switch (home.kind) {
    case "date":
      return `0${home.date}`;
    case "period":
      return `1${home.horizon === "week" ? 0 : home.horizon === "month" ? 1 : 2}${home.startsOn}`;
    case "backlog":
      return `2${home.horizon === "week" ? 0 : home.horizon === "month" ? 1 : home.horizon === "year" ? 2 : 3}`;
  }
}

/** The All tasks view: open one-off tasks by home, then repeating ones. */
export function allTasks(
  tasks: ReadonlyArray<Task>,
  filter: TaskBacklogFilter,
): { readonly open: Task[]; readonly recurring: Task[]; readonly completed: number } {
  const open = listed(tasks).filter((task) => task.status === "todo");
  const matches = (task: Task) =>
    filter === "all" ||
    (filter === "recurring"
      ? task.recurrence !== undefined
      : task.home.kind === "backlog" && task.home.horizon === filter);
  const oneOff = open
    .filter((task) => task.recurrence === undefined && matches(task))
    .sort((a, b) => homeRank(a.home).localeCompare(homeRank(b.home)) || compareTaskOrder(a, b));
  const recurring =
    filter === "all" || filter === "recurring"
      ? open.filter((task) => task.recurrence !== undefined).sort(compareTaskOrder)
      : [];
  return {
    open: filter === "recurring" ? [] : oneOff,
    recurring,
    completed: listed(tasks).filter((task) => task.status === "completed").length,
  };
}

export function taskIntentFor(
  intents: ReadonlyArray<TaskIntent> | undefined,
  horizon: TaskHorizon,
  today: string,
): TaskIntent | undefined {
  const { startsOn } = taskPeriodFor(horizon, today);
  return intents?.find((intent) => intent.horizon === horizon && intent.startsOn === startsOn);
}

/** Restricts a list to one Project, or to tasks without one (`"none"`). */
export function filterTasksByProject(
  tasks: ReadonlyArray<Task>,
  projectId: string | "none" | null,
): Task[] {
  if (projectId === null) return [...tasks];
  return tasks.filter((task) =>
    projectId === "none"
      ? task.links?.projectId === undefined
      : task.links?.projectId === projectId,
  );
}

// Lifecycle of a task handed to an agent.

export type TaskAgentState =
  | { readonly kind: "open" }
  | { readonly kind: "handed-off"; readonly threadId: string }
  | { readonly kind: "agent-working"; readonly threadId: string; readonly since: string | null }
  | { readonly kind: "needs-you"; readonly status: ProjectStatus }
  | { readonly kind: "workstream-done"; readonly status: ProjectStatus }
  | { readonly kind: "completed" };

export interface TaskLifecycleThread {
  readonly id: string;
  readonly session: { readonly status: string } | null;
  readonly latestTurn?: { readonly startedAt?: string | null } | null;
}

export interface TaskLifecycleProject {
  readonly id: string;
  readonly assistant?: { readonly statuses?: ReadonlyArray<ProjectStatus> | undefined } | null;
}

export function linkedStatusOf(
  task: Pick<Task, "links">,
  projects: ReadonlyArray<TaskLifecycleProject>,
): ProjectStatus | undefined {
  const { projectId, statusId } = task.links ?? {};
  if (projectId === undefined || statusId === undefined) return undefined;
  return projects
    .find((project) => project.id === projectId)
    ?.assistant?.statuses?.find((status) => status.id === statusId);
}

/**
 * Where a task stands: its workstream's state wins (needs you, done), then
 * the handed-off thread's live session. A finished workstream asks the user
 * to complete the task until they answer "Not yet" for that version.
 */
export function taskAgentState(
  task: Task,
  threads: ReadonlyArray<TaskLifecycleThread>,
  projects: ReadonlyArray<TaskLifecycleProject>,
): TaskAgentState {
  if (task.status !== "todo") return { kind: "completed" };
  const status = linkedStatusOf(task, projects);
  if (status !== undefined) {
    if (status.state === "needs-you" && status.decision?.answeredAt === undefined) {
      return { kind: "needs-you", status };
    }
    if (status.state === "done") {
      const dismissed = task.completionPromptDismissedAt;
      if (dismissed === undefined || dismissed < status.updatedAt) {
        return { kind: "workstream-done", status };
      }
    }
  }
  const threadId = task.handoff?.threadId ?? task.links?.threadId;
  if (threadId === undefined) return { kind: "open" };
  const thread = threads.find((entry) => entry.id === threadId);
  const running = thread?.session?.status === "running" || thread?.session?.status === "starting";
  if (running) {
    return {
      kind: "agent-working",
      threadId,
      since: thread?.latestTurn?.startedAt ?? null,
    };
  }
  return task.handoff !== undefined ? { kind: "handed-off", threadId } : { kind: "open" };
}

/** Tasks linked to one workstream, for its Status row. */
export function tasksForStatus(
  tasks: ReadonlyArray<Task>,
  projectId: string,
  statusId: string,
): Task[] {
  return tasks.filter(
    (task) =>
      !isProposedTask(task) &&
      task.status === "todo" &&
      task.links?.projectId === projectId &&
      task.links.statusId === statusId,
  );
}

/** The open task linked to a thread, for its header. */
export function taskForThread(tasks: ReadonlyArray<Task>, threadId: string): Task | undefined {
  return tasks.find(
    (task) =>
      !isProposedTask(task) &&
      task.status === "todo" &&
      (task.links?.threadId === threadId || task.handoff?.threadId === threadId),
  );
}

/** Proposals from one Project, for the coordinator thread. */
export function proposedTasksForProject(tasks: ReadonlyArray<Task>, projectId: string): Task[] {
  return proposedTasks(tasks).filter((task) => task.proposal?.projectId === projectId);
}

/** Needs-you count across one Project's board, for rows outside the thread. */
export function projectNeedsYouCount(project: {
  readonly assistant?: { readonly statuses?: ReadonlyArray<ProjectStatus> } | null;
}): number {
  return countStatusesNeedingUser(
    (project.assistant?.statuses ?? []).filter((status) => status.dismissedAt === undefined),
  );
}

/** The brief a task hands to an agent: the title, then the notes. */
export function taskBrief(task: Pick<Task, "title" | "notes">): string {
  const title = /[.!?]$/.test(task.title) ? task.title : `${task.title}.`;
  return task.notes === undefined ? title : `${title}\n\n${task.notes}`;
}

// Quick add: "Ask Dana for Q1 numbers tomorrow 9am".

export interface ParsedQuickAdd {
  readonly title: string;
  readonly home: TaskHome | null;
  /** The matched phrase, for highlighting. */
  readonly phrase: string | null;
}

const TIME = String.raw`(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?`;
const WEEKDAY_WORDS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function parseTime(hourText: string, minuteText: string | undefined, meridiem: string | undefined) {
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (hour > 23 || minute > 59) return null;
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem.toLowerCase() === "pm" && hour !== 12) hour += 12;
    if (meridiem.toLowerCase() === "am" && hour === 12) hour = 0;
  } else if (minuteText === undefined) {
    // A bare number is not a time ("10 calls").
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Pulls a trailing when-phrase off a quick-add title: today, tomorrow, a
 * weekday, this week / month / year, or someday, optionally with a time.
 */
export function parseQuickAdd(text: string, today: string): ParsedQuickAdd {
  const trimmed = text.trim();
  const pattern = new RegExp(
    String.raw`\s+(today|tonight|tomorrow|tmrw|${WEEKDAY_WORDS.join("|")}|this week|this month|this year|next week|someday)(?:\s+${TIME})?$`,
    "i",
  );
  const match = pattern.exec(trimmed);
  if (match === null) return { title: trimmed, home: null, phrase: null };
  const word = match[1]!.toLowerCase();
  const time =
    match[2] !== undefined
      ? parseTime(match[2], match[3], match[4])
      : word === "tonight"
        ? "20:00"
        : null;
  if (match[2] !== undefined && time === null) return { title: trimmed, home: null, phrase: null };
  const title = trimmed.slice(0, match.index).trim();
  if (title.length === 0) return { title: trimmed, home: null, phrase: null };
  const day = (date: string): TaskHome => ({
    kind: "date",
    date,
    ...(time !== null ? { reminderTime: time } : {}),
  });
  let home: TaskHome;
  switch (word) {
    case "today":
    case "tonight":
      home = day(today);
      break;
    case "tomorrow":
    case "tmrw":
      home = day(addTaskDays(today, 1));
      break;
    case "this week":
    case "this month":
    case "this year": {
      const horizon = word.slice(5) as TaskHorizon;
      home = { kind: "period", horizon, ...taskPeriodFor(horizon, today) };
      break;
    }
    case "next week": {
      const next = taskPeriodFor("week", addTaskDays(today, 7));
      home = { kind: "period", horizon: "week", ...next };
      break;
    }
    case "someday":
      home = { kind: "backlog", horizon: null };
      break;
    default: {
      const target = WEEKDAY_WORDS.indexOf(word);
      const ahead = (target - taskWeekday(today) + 7) % 7 || 7;
      home = day(addTaskDays(today, ahead));
    }
  }
  return { title, home, phrase: match[0].trim() };
}

/** The Move menu's targets, shared by desktop and mobile. */
export type TaskMoveTarget =
  | { readonly kind: "today" }
  | { readonly kind: "tomorrow" }
  | { readonly kind: "date"; readonly date: string }
  | { readonly kind: "commit"; readonly horizon: TaskHorizon }
  | { readonly kind: "backlog"; readonly horizon: TaskHorizon | null };

/** The home a move lands on. A date move keeps the reminder time. */
export function homeForMove(target: TaskMoveTarget, current: TaskHome, today: string): TaskHome {
  const reminder =
    current.kind === "date" && current.reminderTime !== undefined
      ? { reminderTime: current.reminderTime }
      : {};
  switch (target.kind) {
    case "today":
      return { kind: "date", date: today, ...reminder };
    case "tomorrow":
      return { kind: "date", date: addTaskDays(today, 1), ...reminder };
    case "date":
      return { kind: "date", date: target.date, ...reminder };
    case "commit":
      return { kind: "period", horizon: target.horizon, ...taskPeriodFor(target.horizon, today) };
    case "backlog":
      return { kind: "backlog", horizon: target.horizon };
  }
}

/** Whether `home` is what `target` would produce, for the menu's check mark. */
export function isHomeAtTarget(home: TaskHome, target: TaskMoveTarget, today: string): boolean {
  switch (target.kind) {
    case "today":
      return home.kind === "date" && home.date === today;
    case "tomorrow":
      return home.kind === "date" && home.date === addTaskDays(today, 1);
    case "date":
      return home.kind === "date" && home.date === target.date;
    case "commit":
      return (
        home.kind === "period" &&
        home.horizon === target.horizon &&
        home.startsOn === taskPeriodFor(target.horizon, today).startsOn
      );
    case "backlog":
      return home.kind === "backlog" && home.horizon === target.horizon;
  }
}

/** Sidebar counts: Today (due or overdue), and this week / month commitments. */
export function taskCounts(
  tasks: ReadonlyArray<Task>,
  today: string,
): {
  readonly today: number;
  readonly week: number;
  readonly month: number;
  readonly year: number;
  readonly proposed: number;
} {
  return {
    today: todayTasks(tasks, today).length,
    week: committedTasks(tasks, "week", today).length,
    month: committedTasks(tasks, "month", today).length,
    year: committedTasks(tasks, "year", today).length,
    proposed: proposedTasks(tasks).length,
  };
}
