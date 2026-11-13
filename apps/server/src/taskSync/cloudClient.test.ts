// @effect-diagnostics globalDate:off - the client under test takes a plain clock.
import { describe, expect, it } from "vite-plus/test";

import { makeTaskSyncCloudClient, signHandshake, TaskSyncCloudError } from "./cloudClient.ts";

const SECRET = "a".repeat(64);
const config = { baseUrl: "https://cloud.test", keyId: "cplane-test-1", secret: SECRET };

function fakeFetch(routes: Record<string, (init: RequestInit) => [number, unknown]>) {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const fetch = async (input: string, init: RequestInit = {}) => {
    const path = input.replace(config.baseUrl, "").split("?")[0]!;
    calls.push({ path, init });
    const route = routes[path];
    const [status, body] = route === undefined ? [404, { error: "not_found" }] : route(init);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

describe("task sync cloud client", () => {
  it("proves its client key with a signed handshake before sign-in calls", async () => {
    const { fetch, calls } = fakeFetch({
      "/api/client/handshake": (init) => {
        const body = JSON.parse(String(init.body));
        const ok = body.sig === signHandshake(SECRET, body.keyId, body.ts, body.nonce);
        return ok ? [200, { token: "client-token", expiresIn: 300 }] : [401, {}];
      },
      "/api/auth/request-code": (init) => [
        (init.headers as Record<string, string>)["x-lucive-client"] === "client-token" ? 200 : 401,
        { ok: true },
      ],
      "/api/auth/verify": () => [200, { token: "device-token", user: { email: "n@example.com" } }],
    });
    const client = makeTaskSyncCloudClient(config, fetch, () => 1_800_000_000_000);
    await client.requestCode("n@example.com");
    const signedIn = await client.verify({
      email: "n@example.com",
      code: "123456",
      deviceName: "Mac",
    });
    expect(signedIn).toEqual({ token: "device-token", email: "n@example.com" });
    // One handshake serves both pre-auth calls while its token is fresh.
    expect(calls.filter((call) => call.path === "/api/client/handshake")).toHaveLength(1);
    const verifyBody = JSON.parse(String(calls.at(-1)!.init.body));
    expect(verifyBody.device).toEqual({ name: "Mac", platform: "macos" });
  });

  it("maps a 402 to inactive and a wrong code to invalid-code", async () => {
    const { fetch } = fakeFetch({
      "/api/planning/changes": () => [402, { error: "task_sync_not_active" }],
      "/api/client/handshake": () => [200, { token: "t", expiresIn: 300 }],
      "/api/auth/verify": () => [401, { error: "invalid_code" }],
    });
    const client = makeTaskSyncCloudClient(config, fetch);
    await expect(client.changes("device", 0)).rejects.toMatchObject({ reason: "inactive" });
    await expect(
      client.verify({ email: "n@example.com", code: "000000", deviceName: "Mac" }),
    ).rejects.toBeInstanceOf(TaskSyncCloudError);
  });

  it("opens the billing portal when checkout finds an active subscription", async () => {
    const { fetch } = fakeFetch({
      "/api/cplane/task-sync/checkout": () => [409, { error: "already_subscribed" }],
      "/api/cplane/task-sync/portal": () => [200, { url: "https://billing.test/portal" }],
      "/api/cplane/task-sync": () => [
        200,
        { status: "grace", active: true, currentPeriodEnd: null, canManage: true },
      ],
    });
    const client = makeTaskSyncCloudClient(config, fetch);
    expect(await client.checkout("device")).toBe("https://billing.test/portal");
    expect(await client.subscription("device")).toEqual({ status: "grace", canManage: true });
  });
});
