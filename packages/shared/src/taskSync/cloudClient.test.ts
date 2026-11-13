import * as NodeCrypto from "node:crypto";

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
  it("treats only a 200 with available: true as Task Sync being on", async () => {
    const answer = async (route: (init: RequestInit) => [number, unknown]) => {
      const { fetch } = fakeFetch({ "/api/task-sync/availability": route });
      return makeTaskSyncCloudClient(config, fetch).availability();
    };
    expect(await answer(() => [200, { available: true }])).toBe(true);
    expect(await answer(() => [200, { available: false }])).toBe(false);
    expect(await answer(() => [200, {}])).toBe(false);
    expect(await answer(() => [503, { available: true }])).toBe(false);
    // Production today: the route doesn't exist yet.
    const { fetch: missing } = fakeFetch({});
    expect(await makeTaskSyncCloudClient(config, missing).availability()).toBe(false);
    const offline = makeTaskSyncCloudClient(config, async () => {
      throw new TypeError("network down");
    });
    expect(await offline.availability()).toBe(false);
  });

  it("signs the handshake exactly as the server checks it", () => {
    // Server (lucive cloud/api/client/handshake.ts): createHmac('sha256', key.secret as string)
    // .update(`${keyId}.${ts}.${nonce}`). The key is the secret string, never hex-decoded.
    // Fixed vector computed with that expression.
    const secret = "0".repeat(32) + "f".repeat(32);
    expect(
      signHandshake(secret, "cplane-test-1", 1_800_000_000, "00112233445566778899aabbccddeeff"),
    ).toBe("54d1902f1f7413878230f82225e7bd12e5ae3206328d1a21cbc3ac73682edba0");
  });

  it("proves its client key with a signed handshake before sign-in calls", async () => {
    const { fetch, calls } = fakeFetch({
      "/api/client/handshake": (init) => {
        const body = JSON.parse(String(init.body));
        // Same computation as the server's handshake check (see the fixed-vector test).
        const expected = NodeCrypto.createHmac("sha256", SECRET)
          .update(`${body.keyId}.${body.ts}.${body.nonce}`)
          .digest("hex");
        const ok =
          body.sig === expected &&
          signHandshake(SECRET, body.keyId, body.ts, body.nonce) === expected;
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
      "/api/planning/changes": () => [402, { error: "task_sync_inactive" }],
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
      "/api/entitlements/task-sync/checkout": () => [409, { error: "already_subscribed" }],
      "/api/entitlements/task-sync/portal": () => [200, { url: "https://billing.test/portal" }],
      "/api/entitlements/task-sync": () => [
        200,
        { status: "past_due", active: true, currentPeriodEnd: null, canManage: true },
      ],
    });
    const client = makeTaskSyncCloudClient(config, fetch);
    expect(await client.checkout("device")).toBe("https://billing.test/portal");
    expect(await client.subscription("device")).toEqual({ status: "grace", canManage: true });
  });
});
