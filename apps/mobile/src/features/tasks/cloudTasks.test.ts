import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
    exists = false;
    textSync() {
      return "";
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
