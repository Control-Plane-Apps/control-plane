// @effect-diagnostics globalDate:off - the engine under test takes a plain clock.
import type { Task, TaskIntent, TaskSyncSubscription } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  TaskSyncCloudError,
  type ChangesPage,
  type PushBatch,
  type TaskSyncCloudClient,
  type WireMembershipFull,
  type WirePeriodFull,
  type WireTaskWithSeq,
} from "./cloudClient.ts";
import { emptyTaskSyncState, TaskSyncEngine, type TaskSyncApply } from "./engine.ts";

const T0 = "2026-11-13T12:00:00.000Z";

/** An in-memory cloud with the real store's rules: LWW by updatedAt, a seq feed. */
class FakeCloud implements TaskSyncCloudClient {
  seq = 0;
  tasks = new Map<string, WireTaskWithSeq & { seq: number }>();
  periods = new Map<string, WirePeriodFull & { seq: number }>();
  memberships = new Map<string, WireMembershipFull & { seq: number }>();
  active = true;
  available = true;
  availabilityChecks = 0;
  changeCalls = 0;
  pushes: PushBatch[] = [];
  /** What `/changes` reports as the account's week start; undefined sends none. */
  weekStartsOn: number | undefined = 1;
  /** Runs while a push is in flight, before the cloud answers. */
  duringPush: (() => Promise<void>) | null = null;

  availability = async () => {
    this.availabilityChecks += 1;
    return this.available;
  };

  seedPeriod(id: string, horizon: "week" | "month", startsOn: string, endsOn: string, extra = {}) {
    this.seq += 1;
    this.periods.set(id, {
      id,
      horizon,
      anchorDate: startsOn,
      startsOn,
      endsOn,
      title: null,
      focus: null,
      state: "open",
      revision: 1,
      createdAt: T0,
      updatedAt: T0,
      deletedAt: null,
      ...extra,
      seq: this.seq,
    });
  }

  seedCommitment(id: string, periodId: string, taskId: string, sortOrder = 0) {
    this.seq += 1;
    this.memberships.set(id, {
      id,
      periodId,
      taskId,
      role: "commitment",
      sortOrder,
      revision: 1,
      createdAt: T0,
      updatedAt: T0,
      deletedAt: null,
      seq: this.seq,
    });
  }

  seedTask(task: Partial<WireTaskWithSeq> & { id: string }) {
    this.seq += 1;
    this.tasks.set(task.id, {
      title: task.id,
      notes: null,
      status: "todo",
      scheduledDate: null,
      reminderTime: null,
      backlogHorizon: null,
      completedAt: null,
      sortOrder: 0,
      isTemplate: false,
      templateId: null,
      recurrence: null,
      createdAt: T0,
      updatedAt: T0,
      deletedAt: null,
      ...task,
      seq: this.seq,
    });
  }

  requestCode = async () => undefined;
  verify = async ({ email }: { email: string }) => ({ token: "device-token", email });
  revoke = async () => undefined;
  subscription = async (): Promise<TaskSyncSubscription> => ({
    status: this.active ? "active" : "inactive",
  });
  checkout = async () => "https://checkout.example/session";
  portal = async () => "https://portal.example/session";

  changes = async (_token: string, since: number): Promise<ChangesPage> => {
    this.changeCalls += 1;
    if (!this.active) throw new TaskSyncCloudError("inactive", 402);
    const after = <T extends { seq: number }>(rows: Iterable<T>) =>
      [...rows].filter((row) => row.seq > since);
    return {
      tasks: after(this.tasks.values()),
      periods: after(this.periods.values()),
      memberships: after(this.memberships.values()),
      nextSince: this.seq,
      hasMore: false,
      ...(this.weekStartsOn === undefined ? {} : { settings: { weekStartsOn: this.weekStartsOn } }),
    };
  };

  push = async (_token: string, batch: PushBatch) => {
    if (!this.active) throw new TaskSyncCloudError("inactive", 402);
    if (this.duringPush !== null) await this.duringPush();
    this.pushes.push(batch);
    const remaps: Array<{ from: string; to: string }> = [];
    for (const raw of batch.periods) {
      const period = raw as unknown as WirePeriodFull;
      const twin = [...this.periods.values()].find(
        (p) => p.horizon === period.horizon && p.startsOn === period.startsOn && p.id !== period.id,
      );
      if (twin !== undefined) {
        remaps.push({ from: period.id, to: twin.id });
        continue;
      }
      this.seq += 1;
      this.periods.set(period.id, { ...period, seq: this.seq });
    }
    for (const raw of batch.tasks) {
      const task = raw as unknown as WireTaskWithSeq;
      const stored = this.tasks.get(task.id);
      if (stored !== undefined && stored.updatedAt >= task.updatedAt) continue;
      this.seq += 1;
      this.tasks.set(task.id, { ...task, seq: this.seq });
    }
    for (const raw of batch.memberships) {
      const membership = raw as unknown as WireMembershipFull;
      const periodId =
        remaps.find((r) => r.from === membership.periodId)?.to ?? membership.periodId;
      this.seq += 1;
      this.memberships.set(membership.id, { ...membership, periodId, seq: this.seq });
    }
    return { remaps: { periods: remaps } };
  };
}

function setup(
  cloud: FakeCloud,
  localTasks: Task[] = [],
  localIntents: TaskIntent[] = [],
  weekStarts: number[] = [],
) {
  let state = emptyTaskSyncState();
  let token: string | null = null;
  let clock = Date.parse(T0);
  let ids = 0;
  const applied: TaskSyncApply[] = [];
  const notified = { count: 0 };
  const local = { tasks: localTasks, intents: localIntents };
  const engine = new TaskSyncEngine({
    client: cloud,
    loadState: async () => state,
    saveState: async (next) => {
      state = next;
    },
    getToken: async () => token,
    setToken: async (next) => {
      token = next;
    },
    apply: async (changes) => {
      applied.push(changes);
      // Like task.sync.apply: pulled records replace theirs, local-only tasks stay.
      const pulled = new Set(changes.tasks.map((t) => t.id as string));
      const removed = new Set(changes.removedTaskIds);
      local.tasks = [
        ...changes.tasks,
        ...local.tasks.filter((t) => !pulled.has(t.id) && !removed.has(t.id)),
      ];
    },
    readLocal: async () => local,
    onApplied: () => {
      notified.count += 1;
    },
    onWeekStart: (day) => weekStarts.push(day),
    deviceName: "Test Mac",
    now: () => new Date((clock += 1000)),
    newId: () => `gen-${(ids += 1)}`,
  });
  return { engine, applied, local, notified, state: () => state };
}

const localTask = (id: string, extra: Partial<Task> = {}): Task =>
  ({
    id,
    title: id,
    status: "todo",
    home: { kind: "date", date: "2026-11-13" },
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  }) as Task;

describe("TaskSyncEngine", () => {
  it("signs in, pulls the account's tasks, and uploads tasks that only existed here", async () => {
    const cloud = new FakeCloud();
    cloud.seedTask({
      id: "remote-1",
      title: "Renew Apple developer account",
      scheduledDate: "2026-11-12",
    });
    const { engine, applied } = setup(cloud, [localTask("local-1", { title: "Call county" })]);

    const status = await engine.verify("Nick@Example.com", "123 456");
    expect(status.state).toBe("synced");
    expect(status.account?.email).toBe("nick@example.com");
    expect(applied[0]!.tasks.map((t) => t.title)).toEqual(["Renew Apple developer account"]);
    expect(cloud.tasks.get("local-1")?.title).toBe("Call county");
    expect(cloud.tasks.get("local-1")?.scheduledDate).toBe("2026-11-13");
  });

  it("queues local edits only after the first merge, and pushes them on the next sync", async () => {
    const cloud = new FakeCloud();
    cloud.seedTask({ id: "t1", title: "Draft list", scheduledDate: "2026-11-13" });
    const { engine, local } = setup(cloud);
    await engine.verify("n@example.com", "123456");

    const completed = { ...local.tasks[0]!, status: "completed" as const, completedAt: T0 };
    local.tasks = [completed];
    await engine.onLocalTask("t1", completed);
    expect((await engine.status()).pendingChanges).toBe(1);
    await engine.sync();
    expect(cloud.tasks.get("t1")?.status).toBe("completed");
    expect((await engine.status()).pendingChanges).toBe(0);
  });

  it("commits to a week through a period and a commitment, adopting another device's period", async () => {
    const cloud = new FakeCloud();
    cloud.seq += 1;
    cloud.periods.set("their-week", {
      id: "their-week",
      horizon: "week",
      anchorDate: "2026-11-09",
      startsOn: "2026-11-09",
      endsOn: "2026-11-15",
      title: null,
      focus: null,
      state: "open",
      revision: 1,
      createdAt: T0,
      updatedAt: T0,
      deletedAt: null,
      seq: cloud.seq,
    });
    cloud.seedTask({ id: "t1", backlogHorizon: "month" });
    const { engine, local } = setup(cloud);
    await engine.verify("n@example.com", "123456");

    const moved = {
      ...local.tasks[0]!,
      home: { kind: "period", horizon: "week", startsOn: "2026-11-09", endsOn: "2026-11-15" },
    } as Task;
    local.tasks = [moved];
    await engine.onLocalTask("t1", moved);
    await engine.sync();
    const membership = [...cloud.memberships.values()].find((m) => m.taskId === "t1");
    expect(membership?.periodId).toBe("their-week");
    expect(membership?.role).toBe("commitment");
    expect(cloud.tasks.get("t1")?.backlogHorizon).toBeNull();
  });

  it("sets a week's intent as that period's focus", async () => {
    const cloud = new FakeCloud();
    const { engine } = setup(cloud);
    await engine.verify("n@example.com", "123456");
    await engine.onLocalIntent("week", "2026-11-09", "Ship payments.");
    await engine.sync();
    const period = [...cloud.periods.values()].find((p) => p.startsOn === "2026-11-09");
    expect(period?.focus).toBe("Ship payments.");
  });

  it("keeps an intent set here when another device created the same week's period first", async () => {
    const cloud = new FakeCloud();
    const { engine, applied } = setup(cloud);
    await engine.verify("n@example.com", "123456");
    await engine.onLocalIntent("week", "2026-11-16", "Get ISN live.");
    // Another device opens the same week before this push goes out.
    cloud.seq += 1;
    cloud.periods.set("their-week", {
      id: "their-week",
      horizon: "week",
      anchorDate: "2026-11-16",
      startsOn: "2026-11-16",
      endsOn: "2026-11-22",
      title: null,
      focus: null,
      state: "open",
      revision: 5,
      createdAt: T0,
      updatedAt: T0,
      deletedAt: null,
      seq: cloud.seq,
    });
    await engine.sync();
    const removed = applied.flatMap((a) => a.removedIntents);
    expect(removed).not.toContainEqual({ horizon: "week", startsOn: "2026-11-16" });
    expect(cloud.periods.get("their-week")?.focus).toBe("Get ISN live.");
    await engine.sync();
    expect(applied.at(-1)!.intents).toContainEqual(
      expect.objectContaining({ horizon: "week", startsOn: "2026-11-16", text: "Get ISN live." }),
    );
  });

  it("lets the other device's focus win when it already has one", async () => {
    const cloud = new FakeCloud();
    const { engine, applied } = setup(cloud);
    await engine.verify("n@example.com", "123456");
    await engine.onLocalIntent("week", "2026-11-16", "Mine.");
    cloud.seq += 1;
    cloud.periods.set("their-week", {
      id: "their-week",
      horizon: "week",
      anchorDate: "2026-11-16",
      startsOn: "2026-11-16",
      endsOn: "2026-11-22",
      title: null,
      focus: "Theirs.",
      state: "open",
      revision: 5,
      createdAt: T0,
      updatedAt: T0,
      deletedAt: null,
      seq: cloud.seq,
    });
    await engine.sync();
    expect(cloud.periods.get("their-week")?.focus).toBe("Theirs.");
    expect(applied.at(-1)!.intents).toContainEqual(
      expect.objectContaining({ startsOn: "2026-11-16", text: "Theirs." }),
    );
  });

  it.each([0, 1])("reports the account's week start (%i) to the host", async (day) => {
    const cloud = new FakeCloud();
    cloud.weekStartsOn = day;
    const seen: number[] = [];
    const { engine } = setup(cloud, [], [], seen);
    await engine.verify("n@example.com", "123456");
    expect(seen.at(-1)).toBe(day);
    expect((await engine.status()).weekStartsOn).toBe(day);
  });

  it("goes back to Monday weeks when the account signs out", async () => {
    const cloud = new FakeCloud();
    cloud.weekStartsOn = 0;
    const seen: number[] = [];
    const { engine } = setup(cloud, [], [], seen);
    await engine.verify("n@example.com", "123456");
    expect(seen.at(-1)).toBe(0);
    await engine.signOut();
    expect(seen.at(-1)).toBe(1);
  });

  it("turns on repeat by creating the series template", async () => {
    const cloud = new FakeCloud();
    cloud.seedTask({ id: "t1", scheduledDate: "2026-11-16" });
    const { engine, local } = setup(cloud);
    await engine.verify("n@example.com", "123456");
    const repeating = {
      ...local.tasks[0]!,
      recurrence: { frequency: "weekly", interval: 1 },
    } as Task;
    local.tasks = [repeating];
    await engine.onLocalTask("t1", repeating);
    await engine.sync();
    const templateId = cloud.tasks.get("t1")?.templateId;
    expect(templateId).toBeTruthy();
    expect(cloud.tasks.get(templateId!)?.isTemplate).toBe(true);
    expect(cloud.tasks.get(templateId!)?.recurrence).toMatchObject({
      frequency: "weekly",
      interval: 1,
      anchor: "calendar",
    });
  });

  it("pushes an end rule to the series template, and updates it when it changes", async () => {
    const cloud = new FakeCloud();
    cloud.seedTask({ id: "t1", scheduledDate: "2026-11-16" });
    const { engine, local } = setup(cloud);
    await engine.verify("n@example.com", "123456");
    const repeating = {
      ...local.tasks[0]!,
      recurrence: { frequency: "weekly", interval: 1, endAfterCount: 3, occurrence: 1 },
    } as Task;
    local.tasks = [repeating];
    await engine.onLocalTask("t1", repeating);
    await engine.sync();
    const templateId = cloud.tasks.get("t1")!.templateId!;
    expect(cloud.tasks.get(templateId)?.recurrence).toEqual({
      frequency: "weekly",
      interval: 1,
      anchor: "calendar",
      endAfterCount: 3,
    });
    const dated = {
      ...repeating,
      seriesId: templateId,
      recurrence: { frequency: "weekly", interval: 1, endAfterDate: "2026-12-31" },
    } as Task;
    local.tasks = [dated];
    await engine.onLocalTask("t1", dated);
    await engine.sync();
    expect(cloud.tasks.get(templateId)?.recurrence).toEqual({
      frequency: "weekly",
      interval: 1,
      anchor: "calendar",
      endAfterDate: "2026-12-31",
    });
  });

  it("never pushes a proposal the user has not added", async () => {
    const cloud = new FakeCloud();
    const { engine } = setup(cloud);
    await engine.verify("n@example.com", "123456");
    await engine.onLocalTask(
      "p1",
      localTask("p1", {
        proposal: { projectId: "p", threadId: "c", proposedAt: T0 } as never,
      }),
    );
    expect((await engine.status()).pendingChanges).toBe(0);
  });

  it("reports inactive on a 402, keeps the edit queued, and resumes once active", async () => {
    const cloud = new FakeCloud();
    cloud.seedTask({ id: "t1" });
    const { engine, local } = setup(cloud);
    await engine.verify("n@example.com", "123456");
    cloud.active = false;
    const renamed = { ...local.tasks[0]!, title: "Renamed" };
    local.tasks = [renamed];
    await engine.onLocalTask("t1", renamed);
    await engine.sync();
    expect((await engine.status()).state).toBe("inactive");
    expect((await engine.status()).pendingChanges).toBe(1);
    cloud.active = true;
    await engine.sync();
    expect((await engine.status()).state).toBe("synced");
    expect(cloud.tasks.get("t1")?.title).toBe("Renamed");
  });

  it("shows coming soon, with no sign-in or sync, until the service switches Task Sync on", async () => {
    const cloud = new FakeCloud();
    cloud.available = false;
    const { engine } = setup(cloud);
    expect((await engine.status()).state).toBe("coming-soon");
    await engine.refreshAvailability(0);
    expect((await engine.status()).state).toBe("coming-soon");
    await expect(engine.requestCode("n@example.com")).rejects.toMatchObject({
      reason: "unavailable",
    });
    await expect(engine.verify("n@example.com", "123456")).rejects.toMatchObject({
      reason: "unavailable",
    });
    await engine.sync();
    expect(cloud.changeCalls).toBe(0);
    expect(cloud.pushes).toHaveLength(0);

    // Background checks reuse the answer for a few hours; an explicit recheck asks again.
    const checks = cloud.availabilityChecks;
    await engine.sync();
    expect(cloud.availabilityChecks).toBe(checks);
    cloud.available = true;
    await engine.refreshAvailability(0);
    expect((await engine.status()).state).toBe("signed-out");
    await engine.verify("n@example.com", "123456");
    expect((await engine.status()).state).toBe("synced");
  });

  it("a local preview lets this install sign in before launch, and turns off cleanly", async () => {
    const cloud = new FakeCloud();
    cloud.available = false;
    const { engine } = setup(cloud);
    engine.setPreview(true);
    await engine.refreshAvailability(0);
    expect(await engine.status()).toMatchObject({ state: "signed-out", preview: true });
    await engine.verify("n@example.com", "123456");
    expect((await engine.status()).state).toBe("synced");
    engine.setPreview(false);
    await engine.refreshAvailability(0);
    expect((await engine.status()).state).toBe("coming-soon");
    expect((await engine.status()).preview).toBeUndefined();
  });

  it("signs out to local-only, keeping tasks here", async () => {
    const cloud = new FakeCloud();
    const { engine } = setup(cloud);
    await engine.verify("n@example.com", "123456");
    const status = await engine.signOut();
    expect(status.state).toBe("signed-out");
  });

  it("keeps a Lucive dated commitment's day when Control Plane edits it in place", async () => {
    const cloud = new FakeCloud();
    cloud.seedPeriod("this-week", "week", "2026-11-09", "2026-11-15");
    cloud.seedTask({
      id: "t1",
      title: "Book flights",
      scheduledDate: "2026-11-12",
      reminderTime: "09:00",
    });
    cloud.seedCommitment("c1", "this-week", "t1");
    const { engine, local } = setup(cloud);
    await engine.verify("n@example.com", "123456");
    // Shown as its week, not its day.
    expect(local.tasks[0]!.home).toMatchObject({ kind: "period", startsOn: "2026-11-09" });

    const renamed = { ...local.tasks[0]!, title: "Book flights to Denver" };
    local.tasks = [renamed];
    await engine.onLocalTask("t1", renamed);
    await engine.sync();
    expect(cloud.tasks.get("t1")).toMatchObject({
      title: "Book flights to Denver",
      scheduledDate: "2026-11-12",
      reminderTime: "09:00",
    });

    // Moving it to another period is an explicit home change: the day clears.
    const moved = {
      ...renamed,
      home: { kind: "period", horizon: "month", startsOn: "2026-11-01", endsOn: "2026-11-30" },
    } as Task;
    local.tasks = [moved];
    await engine.onLocalTask("t1", moved);
    await engine.sync();
    expect(cloud.tasks.get("t1")).toMatchObject({ scheduledDate: null, reminderTime: null });
  });

  it("keeps a record queued during a push for the next one", async () => {
    const cloud = new FakeCloud();
    cloud.seedTask({ id: "t1" });
    cloud.seedTask({ id: "t2" });
    const { engine, local } = setup(cloud);
    await engine.verify("n@example.com", "123456");
    const first = { ...local.tasks.find((t) => t.id === "t1")!, title: "First" };
    const second = { ...local.tasks.find((t) => t.id === "t2")!, title: "Second" };
    await engine.onLocalTask("t1", first);
    cloud.duringPush = async () => {
      cloud.duringPush = null;
      await engine.onLocalTask("t2", second);
    };
    await engine.sync();
    expect(cloud.tasks.get("t1")?.title).toBe("First");
    expect((await engine.status()).pendingChanges).toBe(1);
    await engine.sync();
    expect(cloud.tasks.get("t2")?.title).toBe("Second");
  });
});

describe("TaskSyncEngine commitment rollover", () => {
  // Monday 16 November 2026: last week (9-15 Nov) has ended.
  const TODAY = "2026-11-16";

  const seeded = () => {
    const cloud = new FakeCloud();
    cloud.seedPeriod("last-week", "week", "2026-11-09", "2026-11-15");
    cloud.seedPeriod("this-week", "week", "2026-11-16", "2026-11-22");
    cloud.seedTask({ id: "rolls", title: "Undated", sortOrder: 40 });
    cloud.seedTask({ id: "dated", scheduledDate: "2026-11-12", reminderTime: "09:00" });
    cloud.seedTask({ id: "already" });
    cloud.seedCommitment("c-rolls", "last-week", "rolls", 2);
    cloud.seedCommitment("c-dated", "last-week", "dated", 1);
    cloud.seedCommitment("c-already", "this-week", "already", 4);
    return cloud;
  };

  it("moves memberships only: the synced task record is untouched", async () => {
    const cloud = seeded();
    const { engine, applied, state } = setup(cloud);
    await engine.verify("n@example.com", "123456");
    const before = structuredClone(state().mirror.tasks);
    const cloudBefore = structuredClone(cloud.tasks.get("rolls"));
    const appliedBefore = applied.length;

    const result = await engine.rollExpiredCommitments(TODAY);
    expect(result).toMatchObject({ state: "done", created: 1, retired: 2 });
    if (result.state !== "done") return;
    expect(result.syncedTaskIds.has("rolls")).toBe(true);

    // No task record changed or queued: same revision-free row, same updatedAt.
    expect(state().mirror.tasks).toEqual(before);
    expect(state().outbox.tasks).toEqual({});
    // The old commitments are tombstoned, one new commitment on this week.
    const outbox = Object.values(state().outbox.memberships);
    const tombstoned = outbox.filter((m) => m.deletedAt !== null).map((m) => m.id);
    expect([...(tombstoned as string[])].sort()).toEqual(["c-dated", "c-rolls"]);
    expect(state().mirror.memberships["c-rolls"]).toMatchObject({ revision: 2 });
    const created = outbox.find((m) => m.deletedAt === null);
    expect(created).toMatchObject({
      taskId: "rolls",
      periodId: "this-week",
      role: "commitment",
      revision: 1,
      // After this week's live commitment (4), not the task's own sortOrder.
      sortOrder: 5,
    });
    expect(created?.id).not.toBe("c-rolls");

    // Control Plane's read model follows through the pull path.
    expect(applied.length).toBe(appliedBefore + 1);
    const homes = Object.fromEntries(applied.at(-1)!.tasks.map((t) => [t.id, t.home]));
    expect(homes.rolls).toEqual({
      kind: "period",
      horizon: "week",
      startsOn: "2026-11-16",
      endsOn: "2026-11-22",
    });
    // The dated commitment shows as its (overdue) day again, reminder kept.
    expect(homes.dated).toEqual({ kind: "date", date: "2026-11-12", reminderTime: "09:00" });

    // Only memberships go up; the cloud's task row is the same.
    await engine.sync();
    const pushed = cloud.pushes.at(-1)!;
    expect(pushed.tasks).toEqual([]);
    expect(pushed.periods).toEqual([]);
    expect(pushed.memberships).toHaveLength(3);
    expect(cloud.tasks.get("rolls")).toEqual(cloudBefore);

    // Nothing left to do.
    const again = await engine.rollExpiredCommitments(TODAY);
    expect(again).toMatchObject({ state: "done", created: 0, retired: 0 });
  });

  it("creates the current period by its natural key when no device has it yet", async () => {
    const cloud = new FakeCloud();
    cloud.seedPeriod("last-week", "week", "2026-11-09", "2026-11-15");
    cloud.seedTask({ id: "t1" });
    cloud.seedCommitment("c1", "last-week", "t1", 7);
    const { engine, state } = setup(cloud);
    await engine.verify("n@example.com", "123456");
    await engine.rollExpiredCommitments(TODAY);
    const periods = Object.values(state().outbox.periods);
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({
      horizon: "week",
      startsOn: "2026-11-16",
      endsOn: "2026-11-22",
      state: "open",
    });
    const created = Object.values(state().outbox.memberships).find((m) => m.deletedAt === null);
    expect(created).toMatchObject({ periodId: periods[0]!.id, sortOrder: 0 });
  });

  it("waits for the account's week start this session before moving anything", async () => {
    const cloud = seeded();
    cloud.weekStartsOn = undefined;
    const { engine, state, notified } = setup(cloud);
    await engine.verify("n@example.com", "123456");
    const notifiedBefore = notified.count;
    expect(await engine.rollExpiredCommitments(TODAY)).toEqual({ state: "waiting" });
    expect(state().outbox.memberships).toEqual({});

    // The next pull brings it: the caller is told, and rollover may run.
    cloud.weekStartsOn = 1;
    await engine.sync();
    expect(notified.count).toBe(notifiedBefore + 1);
    expect(await engine.rollExpiredCommitments(TODAY)).toMatchObject({ state: "done" });
  });

  it("tells the caller after a sync that applied pulled records, not after a quiet one", async () => {
    const cloud = seeded();
    const { engine, notified } = setup(cloud);
    await engine.verify("n@example.com", "123456");
    const afterSignIn = notified.count;
    expect(afterSignIn).toBeGreaterThan(0);
    await engine.sync();
    expect(notified.count).toBe(afterSignIn);
    cloud.seedTask({ id: "new" });
    await engine.sync();
    expect(notified.count).toBe(afterSignIn + 1);
    // A rollover's own apply does not ask for another rollover.
    await engine.rollExpiredCommitments(TODAY);
    expect(notified.count).toBe(afterSignIn + 1);
  });

  it("leaves everything to the caller when not signed in", async () => {
    const { engine } = setup(seeded());
    expect(await engine.rollExpiredCommitments(TODAY)).toEqual({ state: "local" });
  });
});
