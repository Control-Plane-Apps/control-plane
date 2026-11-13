/**
 * Task Sync engine: keeps this server's tasks in step with the account's
 * cloud task store. Plain TypeScript over injected storage, client and
 * dispatch, so it tests against an in-memory cloud.
 *
 * The cloud is the source of truth for task records. The server keeps a
 * mirror of the cloud's records (tasks, periods, commitments) and an outbox
 * of local edits, pushed with last-writer-wins whole records like the
 * account's other apps. Pulled records reach the event store through one
 * internal command; Control Plane-only data (links, proposals, handoffs)
 * never leaves this machine. A proposal is pushed only once accepted.
 */
import {
  addTaskDays,
  compareTaskOrder,
  taskPeriodFor,
  isProposedTask,
  type Task,
  type TaskHome,
  type TaskHorizon,
  type TaskIntent,
  type TaskRecurrence,
  type TaskSyncStatus,
  type TaskSyncSubscription,
} from "@t3tools/contracts";
import {
  controlPlaneIntentsFromLucive,
  controlPlaneTasksFromLucive,
  lucivePlacementOf,
} from "@t3tools/shared/taskSyncRecords";

import {
  TaskSyncCloudError,
  type TaskSyncCloudClient,
  type WireMembershipFull,
  type WirePeriodFull,
  type WireTaskWithSeq,
} from "./cloudClient.ts";

type Wire = Record<string, unknown>;

export interface TaskSyncPersistedState {
  readonly version: 1;
  account?: { email: string };
  cursor: number;
  weekStartsOn: number;
  lastSyncedAt?: string;
  subscription?: TaskSyncSubscription;
  inactive?: boolean;
  /** Set once the first full pull ran and local-only tasks were uploaded. */
  initialMergeDone?: boolean;
  mirror: {
    tasks: Record<string, WireTaskWithSeq>;
    periods: Record<string, WirePeriodFull>;
    memberships: Record<string, WireMembershipFull>;
  };
  outbox: {
    tasks: Record<string, Wire>;
    periods: Record<string, Wire>;
    memberships: Record<string, Wire>;
  };
}

export function emptyTaskSyncState(): TaskSyncPersistedState {
  return {
    version: 1,
    cursor: 0,
    weekStartsOn: 1,
    mirror: { tasks: {}, periods: {}, memberships: {} },
    outbox: { tasks: {}, periods: {}, memberships: {} },
  };
}

export interface TaskSyncApply {
  readonly tasks: ReadonlyArray<Task>;
  readonly removedTaskIds: ReadonlyArray<string>;
  readonly intents: ReadonlyArray<TaskIntent>;
  readonly removedIntents: ReadonlyArray<{ horizon: TaskHorizon; startsOn: string }>;
}

export interface TaskSyncEngineDeps {
  readonly client: TaskSyncCloudClient | null;
  readonly loadState: () => Promise<TaskSyncPersistedState>;
  readonly saveState: (state: TaskSyncPersistedState) => Promise<void>;
  readonly getToken: () => Promise<string | null>;
  readonly setToken: (token: string | null) => Promise<void>;
  /** Applies pulled records to the event store (`task.sync.apply`). */
  readonly apply: (changes: TaskSyncApply) => Promise<void>;
  /** The server's current tasks and intents. */
  readonly readLocal: () => Promise<{
    tasks: ReadonlyArray<Task>;
    intents: ReadonlyArray<TaskIntent>;
  }>;
  readonly onWeekStart?: (day: number) => void;
  readonly deviceName: string;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly log?: (message: string, detail?: unknown) => void;
}

const PULL_PAGE_GUARD = 200;

function toWireRecurrence(recurrence: TaskRecurrence): Wire {
  return {
    frequency: recurrence.frequency,
    interval: recurrence.interval,
    anchor: "calendar",
    ...(recurrence.daysOfWeek !== undefined ? { daysOfWeek: recurrence.daysOfWeek } : {}),
    ...(recurrence.dayOfMonth !== undefined ? { dayOfMonth: recurrence.dayOfMonth } : {}),
  };
}

function sameRecurrence(wire: unknown, recurrence: TaskRecurrence): boolean {
  if (typeof wire !== "object" || wire === null) return false;
  const w = wire as Record<string, unknown>;
  return (
    w.frequency === recurrence.frequency &&
    w.interval === recurrence.interval &&
    JSON.stringify(w.daysOfWeek ?? null) === JSON.stringify(recurrence.daysOfWeek ?? null) &&
    (w.dayOfMonth ?? null) === (recurrence.dayOfMonth ?? null)
  );
}

export class TaskSyncEngine {
  private state: TaskSyncPersistedState | null = null;
  private syncing = false;
  private lastError: string | undefined;
  private readonly deps: TaskSyncEngineDeps;

  constructor(deps: TaskSyncEngineDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now();
  }

  private async load(): Promise<TaskSyncPersistedState> {
    if (this.state === null) {
      this.state = await this.deps.loadState();
      this.deps.onWeekStart?.(this.state.weekStartsOn);
    }
    return this.state;
  }

  private async save(): Promise<void> {
    if (this.state !== null) await this.deps.saveState(this.state);
  }

  private pendingCount(state: TaskSyncPersistedState): number {
    return (
      Object.keys(state.outbox.tasks).length +
      Object.keys(state.outbox.periods).length +
      Object.keys(state.outbox.memberships).length
    );
  }

  async status(): Promise<TaskSyncStatus> {
    const state = await this.load();
    const base = {
      pendingChanges: this.pendingCount(state),
      weekStartsOn: state.weekStartsOn,
      ...(state.lastSyncedAt !== undefined ? { lastSyncedAt: state.lastSyncedAt } : {}),
      ...(state.subscription !== undefined ? { subscription: state.subscription } : {}),
    };
    if (this.deps.client === null) return { state: "unavailable", ...base };
    if (state.account === undefined || (await this.deps.getToken()) === null) {
      return { state: "signed-out", ...base };
    }
    const account = { account: state.account };
    if (state.inactive === true) return { state: "inactive", ...account, ...base };
    if (this.syncing) return { state: "syncing", ...account, ...base };
    if (this.lastError !== undefined) {
      return { state: "error", ...account, ...base, error: this.lastError };
    }
    return { state: "synced", ...account, ...base };
  }

  private requireClient(): TaskSyncCloudClient {
    if (this.deps.client === null) throw new TaskSyncCloudError("unavailable");
    return this.deps.client;
  }

  private async requireToken(): Promise<string> {
    const token = await this.deps.getToken();
    if (token === null) throw new TaskSyncCloudError("signed-out");
    return token;
  }

  async requestCode(email: string): Promise<void> {
    const trimmed = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) throw new TaskSyncCloudError("invalid-email");
    await this.requireClient().requestCode(trimmed);
  }

  /** Signs in, then merges: cloud records win, local-only tasks upload. */
  async verify(email: string, code: string): Promise<TaskSyncStatus> {
    const client = this.requireClient();
    const result = await client.verify({
      email: email.trim().toLowerCase(),
      code: code.replace(/\s+/g, ""),
      deviceName: this.deps.deviceName,
    });
    await this.deps.setToken(result.token);
    const fresh = emptyTaskSyncState();
    this.state = { ...fresh, account: { email: result.email } };
    this.lastError = undefined;
    await this.save();
    await this.refreshSubscription().catch(() => undefined);
    await this.sync();
    return this.status();
  }

  /** Signs out of the account. Tasks stay on this machine. */
  async signOut(): Promise<TaskSyncStatus> {
    const token = await this.deps.getToken();
    if (token !== null && this.deps.client !== null) await this.deps.client.revoke(token);
    await this.deps.setToken(null);
    this.state = emptyTaskSyncState();
    this.lastError = undefined;
    await this.save();
    return this.status();
  }

  async refreshSubscription(): Promise<TaskSyncSubscription | undefined> {
    const client = this.requireClient();
    const token = await this.requireToken();
    const state = await this.load();
    state.subscription = await client.subscription(token);
    if (state.subscription.status !== "inactive") state.inactive = false;
    await this.save();
    return state.subscription;
  }

  async checkoutUrl(): Promise<string> {
    return this.requireClient().checkout(await this.requireToken());
  }

  async portalUrl(): Promise<string> {
    return this.requireClient().portal(await this.requireToken());
  }

  /** Push the outbox, then pull until caught up. Safe to call any time. */
  async sync(): Promise<void> {
    if (this.syncing || this.deps.client === null) return;
    const token = await this.deps.getToken();
    const state = await this.load();
    if (token === null || state.account === undefined) return;
    this.syncing = true;
    try {
      if (state.initialMergeDone === true) await this.push(token);
      await this.pull(token);
      if (state.initialMergeDone !== true) {
        await this.uploadLocalOnly();
        state.initialMergeDone = true;
        await this.push(token);
      }
      const wasInactive = state.inactive === true || state.subscription?.status === "inactive";
      state.inactive = false;
      state.lastSyncedAt = this.now().toISOString();
      // Just subscribed: read the renewal date and manage link once.
      if (wasInactive) await this.refreshSubscription().catch(() => undefined);
      this.lastError = undefined;
      await this.save();
    } catch (error) {
      if (error instanceof TaskSyncCloudError && error.reason === "inactive") {
        state.inactive = true;
        this.lastError = undefined;
        await this.save();
      } else if (error instanceof TaskSyncCloudError && error.reason === "signed-out") {
        // The account revoked this device: back to local-only.
        await this.deps.setToken(null);
        this.state = emptyTaskSyncState();
        await this.save();
      } else {
        this.lastError =
          error instanceof TaskSyncCloudError && error.reason === "network"
            ? "Couldn't reach Control Plane's servers. Changes are saved here and will sync."
            : "Sync failed. Changes are saved here and will sync.";
        this.deps.log?.("task sync failed", error);
      }
    } finally {
      this.syncing = false;
    }
  }

  private async push(token: string): Promise<void> {
    const state = await this.load();
    if (this.pendingCount(state) === 0) return;
    const batch = {
      periods: Object.values(state.outbox.periods),
      tasks: Object.values(state.outbox.tasks),
      memberships: Object.values(state.outbox.memberships),
    };
    const result = await this.requireClient().push(token, batch);
    for (const remap of result.remaps?.periods ?? []) {
      // Another device created the same period first: adopt its id.
      const period = state.mirror.periods[remap.from];
      if (period !== undefined) {
        delete state.mirror.periods[remap.from];
        state.mirror.periods[remap.to] = { ...period, id: remap.to };
      }
      for (const membership of Object.values(state.mirror.memberships)) {
        if (membership.periodId === remap.from) {
          state.mirror.memberships[membership.id] = { ...membership, periodId: remap.to };
        }
      }
    }
    state.outbox = { tasks: {}, periods: {}, memberships: {} };
    await this.save();
  }

  private async pull(token: string): Promise<void> {
    const state = await this.load();
    let changed = false;
    for (let page = 0; page < PULL_PAGE_GUARD; page += 1) {
      const result = await this.requireClient().changes(token, state.cursor);
      for (const task of result.tasks) state.mirror.tasks[task.id] = task;
      for (const period of result.periods) state.mirror.periods[period.id] = period;
      for (const membership of result.memberships) {
        state.mirror.memberships[membership.id] = membership;
      }
      if (result.tasks.length + result.periods.length + result.memberships.length > 0) {
        changed = true;
      }
      const weekStartsOn = result.settings?.weekStartsOn;
      if (typeof weekStartsOn === "number" && weekStartsOn !== state.weekStartsOn) {
        state.weekStartsOn = weekStartsOn;
        this.deps.onWeekStart?.(weekStartsOn);
      }
      state.cursor = result.nextSince;
      if (!result.hasMore) break;
    }
    await this.save();
    if (changed) await this.applyMirror();
  }

  /** Every cloud record as Control Plane sees it, applied in one command. */
  private async applyMirror(): Promise<void> {
    const state = await this.load();
    const mirror = {
      tasks: Object.values(state.mirror.tasks),
      periods: Object.values(state.mirror.periods),
      memberships: Object.values(state.mirror.memberships),
    };
    const today = this.localDate();
    const tasks = controlPlaneTasksFromLucive(mirror, today);
    const live = new Set(tasks.map((task) => task.id as string));
    const removedTaskIds = mirror.tasks.filter((task) => !live.has(task.id)).map((task) => task.id);
    const intents = controlPlaneIntentsFromLucive(mirror);
    const removedIntents = mirror.periods
      .filter(
        (period) =>
          period.horizon !== "day" &&
          (period.deletedAt !== null || (period.focus ?? "").trim().length === 0),
      )
      .map((period) => ({ horizon: period.horizon as TaskHorizon, startsOn: period.startsOn }));
    await this.deps.apply({ tasks, removedTaskIds, intents, removedIntents });
  }

  private localDate(): string {
    return new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(this.now());
  }

  /** After the first pull: tasks that exist only here go up to the account. */
  private async uploadLocalOnly(): Promise<void> {
    const state = await this.load();
    const local = await this.deps.readLocal();
    for (const task of local.tasks) {
      if (isProposedTask(task) || state.mirror.tasks[task.id] !== undefined) continue;
      await this.recordLocalTask(task, local.tasks, false);
    }
    for (const intent of local.intents) {
      await this.recordLocalIntent(intent.horizon, intent.startsOn, intent.text, false);
    }
    await this.save();
  }

  /** Is the engine signed in and past its first merge, so edits should queue? */
  private async queuing(): Promise<boolean> {
    if (this.deps.client === null) return false;
    const state = await this.load();
    return state.account !== undefined && state.initialMergeDone === true;
  }

  /** A local edit to one task (null: deleted). Queues it for the cloud. */
  async onLocalTask(taskId: string, task: Task | null): Promise<void> {
    if (!(await this.queuing())) return;
    const state = await this.load();
    if (task === null) {
      const stored = state.mirror.tasks[taskId];
      if (stored === undefined) return;
      const at = this.now().toISOString();
      this.queueTask({ ...stored, deletedAt: at, updatedAt: at });
      this.retireCommitments(taskId, at, null);
      await this.save();
      return;
    }
    if (isProposedTask(task)) return;
    const local = await this.deps.readLocal();
    await this.recordLocalTask(task, local.tasks, true);
  }

  async onLocalIntent(horizon: TaskHorizon, startsOn: string, text: string | null): Promise<void> {
    if (!(await this.queuing())) return;
    await this.recordLocalIntent(horizon, startsOn, text, true);
  }

  private queueTask(wire: WireTaskWithSeq): void {
    const state = this.state!;
    state.mirror.tasks[wire.id] = wire;
    const { seq: _seq, ...outgoing } = wire;
    state.outbox.tasks[wire.id] = outgoing;
  }

  private queuePeriod(period: WirePeriodFull): void {
    const state = this.state!;
    state.mirror.periods[period.id] = period;
    state.outbox.periods[period.id] = { ...period };
  }

  private queueMembership(membership: WireMembershipFull): void {
    const state = this.state!;
    state.mirror.memberships[membership.id] = membership;
    state.outbox.memberships[membership.id] = { ...membership };
  }

  /** Tombstones a task's live commitments except the one to `keepPeriodId`. */
  private retireCommitments(taskId: string, at: string, keepPeriodId: string | null): void {
    for (const membership of Object.values(this.state!.mirror.memberships)) {
      if (
        membership.taskId !== taskId ||
        membership.role !== "commitment" ||
        membership.deletedAt !== null ||
        membership.periodId === keepPeriodId
      ) {
        continue;
      }
      this.queueMembership({
        ...membership,
        revision: membership.revision + 1,
        updatedAt: at,
        deletedAt: at,
      });
    }
  }

  private periodFor(horizon: TaskHorizon, startsOn: string, endsOn: string, at: string) {
    const state = this.state!;
    const existing = Object.values(state.mirror.periods).find(
      (period) =>
        period.horizon === horizon && period.startsOn === startsOn && period.deletedAt === null,
    );
    if (existing !== undefined) return existing;
    const created: WirePeriodFull = {
      id: this.deps.newId(),
      horizon,
      anchorDate: startsOn,
      startsOn,
      endsOn,
      title: null,
      focus: null,
      state: "open",
      revision: 1,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    this.queuePeriod(created);
    return created;
  }

  /** A sort order between the task's neighbors in Control Plane's order. */
  private sortOrderFor(task: Task, all: ReadonlyArray<Task>): number {
    const state = this.state!;
    const ordered = [...all]
      .filter((t) => t.status === "todo" || t.id === task.id)
      .sort(compareTaskOrder);
    const index = ordered.findIndex((t) => t.id === task.id);
    const orderOf = (t: Task | undefined) =>
      t === undefined ? undefined : state.mirror.tasks[t.id]?.sortOrder;
    const before = orderOf(ordered[index - 1]);
    const after = orderOf(ordered[index + 1]);
    const own = state.mirror.tasks[task.id]?.sortOrder;
    if (
      own !== undefined &&
      (before === undefined || own > before) &&
      (after === undefined || own < after)
    ) {
      return own;
    }
    if (before !== undefined && after !== undefined) return (before + after) / 2;
    if (before !== undefined) return before + 1;
    if (after !== undefined) return after - 1;
    return own ?? 0;
  }

  private async recordLocalTask(
    task: Task,
    all: ReadonlyArray<Task>,
    persist: boolean,
  ): Promise<void> {
    const state = await this.load();
    const at = this.now().toISOString();
    const stored = state.mirror.tasks[task.id];
    const placement = lucivePlacementOf(task.home);
    let templateId: string | null = stored?.templateId ?? task.seriesId ?? null;
    const template = templateId === null ? undefined : state.mirror.tasks[templateId];

    // Repeat rules live on the series template.
    if (task.recurrence !== undefined && task.home.kind === "date") {
      if (template !== undefined && template.deletedAt === null) {
        if (!sameRecurrence(template.recurrence, task.recurrence)) {
          this.queueTask({
            ...template,
            recurrence: toWireRecurrence(task.recurrence),
            updatedAt: at,
          });
        }
      } else {
        const created: WireTaskWithSeq = {
          id: this.deps.newId(),
          title: task.title,
          notes: task.notes ?? null,
          status: "todo",
          scheduledDate: task.home.date,
          reminderTime: task.home.reminderTime ?? null,
          backlogHorizon: null,
          completedAt: null,
          sortOrder: 0,
          isTemplate: true,
          templateId: null,
          recurrence: toWireRecurrence(task.recurrence),
          entryRef: null,
          createdAt: at,
          updatedAt: at,
          deletedAt: null,
        };
        this.queueTask(created);
        templateId = created.id;
      }
    } else if (
      task.recurrence === undefined &&
      template !== undefined &&
      template.deletedAt === null &&
      task.status === "todo"
    ) {
      // Repeat turned off: the series ends; this occurrence stays as a plain task.
      this.queueTask({ ...template, deletedAt: at, updatedAt: at });
      templateId = null;
    }

    const wire: WireTaskWithSeq = {
      ...(stored ?? {}),
      id: task.id,
      title: task.title,
      notes: task.notes ?? null,
      status: task.status,
      scheduledDate: placement.scheduledDate,
      reminderTime: placement.reminderTime,
      backlogHorizon: placement.backlogHorizon,
      completedAt: task.status === "todo" ? null : (task.completedAt ?? at),
      sortOrder: this.sortOrderFor(task, all),
      isTemplate: false,
      templateId,
      recurrence: null,
      entryRef: stored?.entryRef ?? null,
      createdAt: stored?.createdAt ?? task.createdAt,
      updatedAt: at,
      deletedAt: null,
    };
    this.queueTask(wire);

    const commitment = placement.commitment;
    if (commitment !== null && task.home.kind === "period") {
      const period = this.periodFor(commitment.horizon, commitment.startsOn, task.home.endsOn, at);
      this.retireCommitments(task.id, at, period.id);
      const live = Object.values(state.mirror.memberships).find(
        (m) =>
          m.taskId === task.id &&
          m.periodId === period.id &&
          m.role === "commitment" &&
          m.deletedAt === null,
      );
      if (live === undefined) {
        this.queueMembership({
          id: this.deps.newId(),
          periodId: period.id,
          taskId: task.id,
          role: "commitment",
          sortOrder: wire.sortOrder,
          revision: 1,
          createdAt: at,
          updatedAt: at,
          deletedAt: null,
        });
      }
    } else {
      this.retireCommitments(task.id, at, null);
    }
    if (persist) await this.save();
  }

  private async recordLocalIntent(
    horizon: TaskHorizon,
    startsOn: string,
    text: string | null,
    persist: boolean,
  ): Promise<void> {
    await this.load();
    const at = this.now().toISOString();
    const endsOn = periodEnd(horizon, startsOn);
    const period = this.periodFor(horizon, startsOn, endsOn, at);
    const focus = text === null || text.trim().length === 0 ? null : text.trim();
    if ((period.focus ?? null) === focus) return;
    this.queuePeriod({ ...period, focus, revision: period.revision + 1, updatedAt: at });
    if (persist) await this.save();
  }
}

function periodEnd(horizon: TaskHorizon, startsOn: string): string {
  return horizon === "week" ? addTaskDays(startsOn, 6) : taskPeriodFor(horizon, startsOn).endsOn;
}

export type { TaskHome };
