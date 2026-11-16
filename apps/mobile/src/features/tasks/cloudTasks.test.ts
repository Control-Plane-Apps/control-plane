import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const files = vi.hoisted(() => ({ state: null as string | null }));

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
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("expo-file-system", () => {
  class Directory {
    exists = false;
    create() {}
  }
  class File {
    name: string;
    constructor(_dir: unknown, name: string) {
      this.name = name;
    }
    get exists() {
      return this.name === "state.json" && files.state !== null;
    }
    textSync() {
      return this.name === "state.json" ? (files.state ?? "") : "";
    }
    write() {}
  }
  return { Directory, File, Paths: { document: "/docs" } };
});
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "id-1" }));

const calls: string[] = [];
let availability: () => Response;

beforeEach(() => {
  calls.length = 0;
  files.state = null;
  vi.resetModules();
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === "/api/task-sync/availability") return availability();
    return new Response("{}", { status: 404 });
  });
});

describe("phone Task Sync gate", () => {
  it("is coming soon and calls nothing else while the service has Task Sync off", async () => {
    availability = () => new Response("{}", { status: 404 });
    const { cloudTaskStore } = await import("./cloudTasks");
    const status = await cloudTaskStore().recheck(0);
    expect(status.state).toBe("coming-soon");
    expect(calls).toEqual(["/api/task-sync/availability"]);
  });

  it("offers sign-in once the service answers available: true", async () => {
    availability = () => new Response(JSON.stringify({ available: true }), { status: 200 });
    const { cloudTaskStore } = await import("./cloudTasks");
    const status = await cloudTaskStore().recheck(0);
    expect(status.state).toBe("signed-out");
  });
});

describe("phone week start", () => {
  it.each([0, 1])("starts weeks on the account's day %i from the saved sync state", async (day) => {
    files.state = JSON.stringify({
      version: 1,
      cursor: 0,
      weekStartsOn: day,
      mirror: { tasks: {}, periods: {}, memberships: {} },
      outbox: { tasks: {}, periods: {}, memberships: {} },
    });
    // Modules reset per test, so read the setting from the instance the store uses.
    const { getTaskWeekStartsOn, setTaskWeekStartsOn } = await import("@t3tools/contracts");
    setTaskWeekStartsOn(day === 0 ? 1 : 0);
    const { cloudTaskStore } = await import("./cloudTasks");
    cloudTaskStore();
    expect(getTaskWeekStartsOn()).toBe(day);
  });
});
