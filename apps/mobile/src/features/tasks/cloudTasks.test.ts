import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The device's documents folder and keychain, in memory. They survive
// vi.resetModules(), which stands in for the app being killed and relaunched.
const device = vi.hoisted(() => ({
  files: new Map<string, string>(),
  token: null as string | null,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios", isPad: false },
  AppState: { currentState: "active", addEventListener: vi.fn() },
}));
vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        taskSync: { url: "https://cloud.test", keyId: "cplane-ios-test", secret: "a".repeat(64) },
      },
    },
  },
}));
vi.mock("expo-crypto", () => ({ getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => device.token),
  setItemAsync: vi.fn(async (_key: string, value: string) => {
    device.token = value;
  }),
  deleteItemAsync: vi.fn(async () => {
    device.token = null;
  }),
}));
vi.mock("expo-file-system", () => {
  class Directory {
    exists = true;
    create() {}
  }
  class File {
    name: string;
    constructor(_dir: unknown, name: string) {
      this.name = name;
    }
    get exists() {
      return device.files.has(this.name);
    }
    textSync() {
      return device.files.get(this.name) ?? "";
    }
    write(text: string) {
      device.files.set(this.name, text);
    }
  }
  return { Directory, File, Paths: { document: "/docs" } };
});
let nextId = 0;
vi.mock("../../lib/uuid", () => ({
  uuidv4: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
}));

/** The account's cloud store, behind the same HTTP routes the phone calls. */
const cloud = {
  online: true,
  available: true,
  seq: 0,
  pushes: [] as Array<{ tasks: Wire[]; periods: Wire[]; memberships: Wire[] }>,
  rows: {
    tasks: new Map<string, Wire>(),
    periods: new Map<string, Wire>(),
    memberships: new Map<string, Wire>(),
  },
};
type Wire = Record<string, unknown> & { id: string };
const calls: string[] = [];

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  calls.push(parsed.pathname);
  if (!cloud.online) throw new TypeError("Network request failed");
  switch (parsed.pathname) {
    case "/api/task-sync/availability":
      return cloud.available ? respond({ available: true }) : respond({}, 404);
    case "/api/planning/changes": {
      const since = Number(parsed.searchParams.get("since") ?? 0);
      const pick = (rows: Map<string, Wire>) =>
        [...rows.values()].filter((row) => (row.seq as number) > since);
      return respond({
        tasks: pick(cloud.rows.tasks),
        periods: pick(cloud.rows.periods),
        memberships: pick(cloud.rows.memberships),
        nextSince: cloud.seq,
        hasMore: false,
        settings: { weekStartsOn: 1 },
      });
    }
    case "/api/planning/push": {
      const batch = JSON.parse(String(init?.body)) as (typeof cloud.pushes)[number];
      cloud.pushes.push(batch);
      for (const kind of ["tasks", "periods", "memberships"] as const) {
        for (const row of batch[kind]) {
          cloud.seq += 1;
          cloud.rows[kind].set(row.id, { ...row, seq: cloud.seq });
        }
      }
      return respond({});
    }
    case "/api/entitlements/task-sync":
      return respond({ status: "active" });
    default:
      return respond({}, 404);
  }
}

/** A phone already signed in to Task Sync, past its first merge. */
function signedInDevice(mirror: Record<string, unknown> = {}) {
  device.token = "device-token";
  device.files.set(
    "state.json",
    JSON.stringify({
      version: 1,
      account: { email: "test@example.com" },
      cursor: 0,
      weekStartsOn: 1,
      initialMergeDone: true,
      mirror: { tasks: {}, periods: {}, memberships: {}, ...mirror },
      outbox: { tasks: {}, periods: {}, memberships: {} },
    }),
  );
}

function savedOutbox(): { tasks: Record<string, Wire>; memberships: Record<string, Wire> } {
  return JSON.parse(device.files.get("state.json")!).outbox;
}

/** Launches the app (fresh modules, same device storage) and starts the store. */
async function launch() {
  vi.resetModules();
  const module = await import("./cloudTasks");
  const store = module.cloudTaskStore();
  store.subscribe(() => undefined);
  await vi.waitFor(() => expect(store.getSnapshot().status).not.toBeNull());
  return store;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
  calls.length = 0;
  device.files.clear();
  device.token = null;
  cloud.online = true;
  cloud.available = true;
  cloud.seq = 0;
  cloud.pushes = [];
  for (const rows of Object.values(cloud.rows)) rows.clear();
  vi.stubGlobal("fetch", fakeFetch);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("phone Task Sync gate", () => {
  it("is coming soon and calls nothing else while the service has Task Sync off", async () => {
    cloud.available = false;
    const { cloudTaskStore } = await import("./cloudTasks");
    const status = await cloudTaskStore().recheck(0);
    expect(status.state).toBe("coming-soon");
    expect(calls).toEqual(["/api/task-sync/availability"]);
  });

  it("offers sign-in once the service answers available: true", async () => {
    vi.resetModules();
    const { cloudTaskStore } = await import("./cloudTasks");
    const status = await cloudTaskStore().recheck(0);
    expect(status.state).toBe("signed-out");
  });
});

describe("phone week start", () => {
  it.each([0, 1])("starts weeks on the account's day %i from the saved sync state", async (day) => {
    vi.resetModules();
    device.files.set(
      "state.json",
      JSON.stringify({
        version: 1,
        cursor: 0,
        weekStartsOn: day,
        mirror: { tasks: {}, periods: {}, memberships: {} },
        outbox: { tasks: {}, periods: {}, memberships: {} },
      }),
    );
    // Modules reset per test, so read the setting from the instance the store uses.
    const { getTaskWeekStartsOn, setTaskWeekStartsOn } = await import("@t3tools/contracts");
    setTaskWeekStartsOn(day === 0 ? 1 : 0);
    const { cloudTaskStore } = await import("./cloudTasks");
    cloudTaskStore();
    expect(getTaskWeekStartsOn()).toBe(day);
  });
});

describe("offline queue", () => {
  it("is the source from launch while offline, and queues edits in the saved outbox", async () => {
    signedInDevice();
    cloud.online = false;
    const store = await launch();
    // Signed in and offline: still the phone's own list, never "coming soon".
    expect(store.getSnapshot().savedAccount).toBe(true);
    expect(store.getSnapshot().status?.state).toBe("error");

    await store.create({
      id: "00000000-0000-4000-8000-0000000000aa" as never,
      title: "Buy milk",
      home: { kind: "date", date: "2026-11-21" },
    });
    await store.patch("00000000-0000-4000-8000-0000000000aa" as never, { status: "completed" });
    expect(store.getSnapshot().tasks.map((task) => [task.title, task.status])).toEqual([
      ["Buy milk", "completed"],
    ]);
    const outbox = savedOutbox();
    expect(Object.keys(outbox.tasks)).toEqual(["00000000-0000-4000-8000-0000000000aa"]);
    expect(outbox.tasks["00000000-0000-4000-8000-0000000000aa"]).toMatchObject({
      status: "completed",
    });
    expect((await store.syncNow()).pendingChanges).toBe(1);
    expect(cloud.pushes).toHaveLength(0);
  });
});

describe("restart persistence", () => {
  it("keeps an offline edit across an app kill, then syncs it once with the same id", async () => {
    signedInDevice();
    cloud.online = false;
    let store = await launch();
    await store.create({
      id: "00000000-0000-4000-8000-0000000000bb" as never,
      title: "Call the bank",
      home: { kind: "backlog", horizon: null },
    });
    // Killed before the list cache was written: only the outbox survived.
    device.files.delete("tasks.json");

    store = await launch();
    await vi.waitFor(() =>
      expect(store.getSnapshot().tasks.map((task) => task.title)).toEqual(["Call the bank"]),
    );

    // Back online: one push carries it, under the id the phone gave it.
    cloud.online = true;
    await store.recheck(0);
    const pushedTasks = cloud.pushes.flatMap((push) => push.tasks.map((task) => task.id));
    expect(pushedTasks).toEqual(["00000000-0000-4000-8000-0000000000bb"]);
    expect(Object.keys(savedOutbox().tasks)).toEqual([]);

    // Later syncs and relaunches send nothing again: no duplicates.
    await store.syncNow();
    store = await launch();
    await store.recheck(0);
    expect(cloud.pushes).toHaveLength(1);
    expect(cloud.rows.tasks.size).toBe(1);
    expect(store.getSnapshot().tasks.map((task) => task.id)).toEqual([
      "00000000-0000-4000-8000-0000000000bb",
    ]);
  });
});

describe("no rollover on the phone", () => {
  it("leaves an expired commitment alone: the Mac alone rolls commitments", async () => {
    const at = "2026-11-01T12:00:00.000Z";
    // Committed to the week of 2 Nov, which has ended; still open and to do.
    cloud.seq = 3;
    cloud.rows.tasks.set("t1", {
      id: "t1",
      title: "Expired commitment",
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
      entryRef: null,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      seq: 1,
    });
    cloud.rows.periods.set("w1", {
      id: "w1",
      horizon: "week",
      anchorDate: "2026-11-02",
      startsOn: "2026-11-02",
      endsOn: "2026-11-08",
      title: null,
      focus: null,
      state: "open",
      revision: 1,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      seq: 2,
    });
    cloud.rows.memberships.set("m1", {
      id: "m1",
      periodId: "w1",
      taskId: "t1",
      role: "commitment",
      sortOrder: 0,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      seq: 3,
    });
    signedInDevice();
    const store = await launch();
    // The engine instance the store uses (same module registry as the launch).
    const { TaskSyncEngine } = await import("@t3tools/shared/taskSync/engine");
    const roll = vi.spyOn(TaskSyncEngine.prototype, "rollExpiredCommitments");
    await store.recheck(0);
    await store.syncNow();
    vi.advanceTimersByTime(5 * 60_000);
    await store.syncNow();

    expect(roll).not.toHaveBeenCalled();
    expect(cloud.pushes).toHaveLength(0);
    expect(cloud.rows.memberships.get("m1")).toMatchObject({ deletedAt: null });
    expect(store.getSnapshot().tasks).toHaveLength(1);
  });

  it("has no call into rollover anywhere in the app's source", () => {
    const root = NodePath.join(__dirname, "../..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of NodeFS.readdirSync(dir)) {
        const path = NodePath.join(dir, name);
        if (NodeFS.statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          if (
            /rollExpiredCommitments|planCommitmentRollover/.test(NodeFS.readFileSync(path, "utf8"))
          ) {
            offenders.push(path);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
