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
  pushes: PushBatch[] = [];

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
    if (!this.active) throw new TaskSyncCloudError("inactive", 402);
    const after = <T extends { seq: number }>(rows: Iterable<T>) =>
      [...rows].filter((row) => row.seq > since);
    return {
      tasks: after(this.tasks.values()),
      periods: after(this.periods.values()),
      memberships: after(this.memberships.values()),
      nextSince: this.seq,
      hasMore: false,
      settings: { weekStartsOn: 1 },
    };
  };

  push = async (_token: string, batch: PushBatch) => {
    if (!this.active) throw new TaskSyncCloudError("inactive", 402);
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

function setup(cloud: FakeCloud, localTasks: Task[] = [], localIntents: TaskIntent[] = []) {
  let state = emptyTaskSyncState();
  let token: string | null = null;
  let clock = Date.parse(T0);
  let ids = 0;
  const applied: TaskSyncApply[] = [];
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
    deviceName: "Test Mac",
    now: () => new Date((clock += 1000)),
    newId: () => `gen-${(ids += 1)}`,
  });
  return { engine, applied, local, state: () => state };
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

  it("signs out to local-only, keeping tasks here", async () => {
    const cloud = new FakeCloud();
    const { engine } = setup(cloud);
    await engine.verify("n@example.com", "123456");
    const status = await engine.signOut();
    expect(status.state).toBe("signed-out");
  });
});
