// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalFetch:off globalFetchInEffect:off globalConsole:off preferSchemaOverJson:off - A black-box test of two real server processes in real time over plain HTTP.
/**
 * Two real servers, each with a fresh data directory, linked both ways with
 * a link token shortened to 24 seconds (test-only `CP_TEST_LINK_TOKEN_TTL_SECONDS`).
 * Proves the link renews by itself in both directions and outlives its first
 * token, that unlinking on the issuer revokes the holder's renewed access, and
 * that relinking with a link minted on the other machine restores it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  type AgentMachineStatus,
  type AgentMachinesInput,
  type AgentMachinesResult,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { describe, expect, it } from "@effect/vitest";
import { afterAll, beforeAll } from "vite-plus/test";

import { TEST_LINK_TOKEN_TTL_ENV } from "../src/agentMachines/linkToken.ts";

const TTL_SECONDS = 24;
const SERVER_BIN = NodePath.resolve(import.meta.dirname, "../src/bin.ts");

interface RunningServer {
  readonly name: string;
  readonly baseDir: string;
  readonly baseUrl: string;
  readonly process: NodeChildProcess.ChildProcess;
  environmentId: string;
  adminToken: string;
  log: string;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<A>(
  label: string,
  probe: () => Promise<A | undefined>,
  timeoutMs: number,
): Promise<A> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${String(last)}` : ""}`);
}

async function startServer(name: string): Promise<RunningServer> {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `cp-link-renewal-${name}-`));
  const port = await freePort();
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      SERVER_BIN,
      "--base-dir",
      baseDir,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-browser",
    ],
    {
      env: {
        ...process.env,
        [TEST_LINK_TOKEN_TTL_ENV]: String(TTL_SECONDS),
        // A fresh, isolated server: no dev URL, no shared home.
        VITE_DEV_SERVER_URL: "",
        T3CODE_HOME: baseDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const server: RunningServer = {
    name,
    baseDir,
    baseUrl: `http://127.0.0.1:${port}`,
    process: child,
    environmentId: "",
    adminToken: "",
    log: "",
  };
  child.stdout?.on("data", (chunk) => (server.log += String(chunk)));
  child.stderr?.on("data", (chunk) => (server.log += String(chunk)));
  const credential = await waitFor(
    `${name} to print its pairing URL`,
    async () => /pairingUrl: \S+#token=([A-Za-z0-9]+)/.exec(server.log)?.[1],
    90_000,
  );
  const descriptor = (await (
    await fetch(`${server.baseUrl}/.well-known/t3/environment`)
  ).json()) as { environmentId: string };
  server.environmentId = descriptor.environmentId;
  const tokenResponse = await fetch(`${server.baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: credential,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
      scope:
        "orchestration:read orchestration:operate terminal:operate review:write relay:read access:read access:write relay:write",
      client_label: "Link renewal test",
    }),
  });
  expect(tokenResponse.status).toBe(200);
  server.adminToken = ((await tokenResponse.json()) as { access_token: string }).access_token;
  return server;
}

class RpcCallError extends Schema.TaggedError<RpcCallError>()("RpcCallError", {
  detail: Schema.String,
}) {}

const toRpcCallError = (cause: unknown) =>
  new RpcCallError({
    detail:
      typeof cause === "object" && cause !== null && "detail" in cause
        ? String((cause as { detail: unknown }).detail)
        : String(cause),
  });

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

/** One RPC call over a fresh WebSocket, authenticated with a ticket from the admin token. */
const rpc = <A>(
  server: RunningServer,
  call: (client: WsRpcClient) => Effect.Effect<A, { readonly _tag: string }>,
): Effect.Effect<A, RpcCallError> =>
  Effect.gen(function* () {
    const ticketResponse = yield* Effect.promise(() =>
      fetch(`${server.baseUrl}/api/auth/websocket-ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.adminToken}` },
      }),
    );
    expect(ticketResponse.status).toBe(200);
    const { ticket } = (yield* Effect.promise(() => ticketResponse.json())) as { ticket: string };
    const wsUrl = `${server.baseUrl.replace("http", "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}`;
    const protocol = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Socket.layerWebSocket(wsUrl).pipe(
          Layer.provide(
            Layer.succeed(
              Socket.WebSocketConstructor,
              (url, protocols) =>
                new NodeSocket.NodeWS.WebSocket(
                  url,
                  protocols as string | string[] | undefined,
                ) as unknown as globalThis.WebSocket,
            ),
          ),
        ),
      ),
      Layer.provide(RpcSerialization.layerJson),
    );
    return yield* makeWsRpcClient.pipe(
      Effect.flatMap(call),
      Effect.provide(protocol),
      Effect.scoped,
      Effect.mapError(toRpcCallError),
    );
  });

const machines = (server: RunningServer, input: AgentMachinesInput) =>
  rpc<AgentMachinesResult>(server, (client) => client["server.agentMachines"](input));

const statusOf = (server: RunningServer, peer: RunningServer) =>
  machines(server, { action: "check" }).pipe(
    Effect.flatMap((result) => {
      const status = result.machines.find((machine) => machine.id === peer.environmentId);
      return status === undefined
        ? Effect.fail(new RpcCallError({ detail: `${server.name} has no link to ${peer.name}` }))
        : Effect.succeed(status);
    }),
  );

const pause = (ms: number) => Effect.promise(() => sleep(ms));

/** A machine link minted on `issuer`; tagged for `holder` when given (a relink), else untagged. */
const pairingFrom = (issuer: RunningServer, forLabel: string, holder?: RunningServer) =>
  rpc<{ pairingUrl: string }>(issuer, (client) =>
    client["server.agentMachinePairing"]({
      baseUrl: issuer.baseUrl,
      label: forLabel,
      ...(holder === undefined ? {} : { holderId: holder.environmentId }),
    }),
  );

/** A general pairing link (not a machine link), as Settings, Connections makes one. */
const generalPairingFrom = (issuer: RunningServer) =>
  Effect.promise(async () => {
    const response = await fetch(`${issuer.baseUrl}/api/auth/pairing-token`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issuer.adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const body = (await response.json()) as { credential: string };
    return `${issuer.baseUrl}/pair#token=${body.credential}`;
  });

/** The link token `holder` stores for `peer`, read from its secrets on disk (a thief's copy). */
const storedToken = (holder: RunningServer, peer: RunningServer) => {
  const name = `agent-machine-token-${Buffer.from(peer.environmentId, "utf8").toString("base64url")}.bin`;
  return JSON.parse(
    NodeFS.readFileSync(NodePath.join(holder.baseDir, "userdata", "secrets", name), "utf8"),
  ) as { token: string; tagged?: boolean; expiresAt: string };
};

const postRenew = (issuer: RunningServer, token: string, environmentId: string) =>
  Effect.promise(async () => {
    const response = await fetch(`${issuer.baseUrl}/api/agent-machine/renew`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ environmentId }),
    });
    return {
      status: response.status,
      body: (await response.json().catch(() => null)) as {
        access_token?: string;
        error?: string;
      } | null,
    };
  });

const shellStatus = (issuer: RunningServer, token: string) =>
  Effect.promise(async () => {
    const response = await fetch(`${issuer.baseUrl}/api/orchestration/shell`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return response.status;
  });

/**
 * A forwarding proxy in front of `target` that lets the first `drops` successful
 * renewals happen on the issuer but never delivers their answers (the socket is
 * reset), as a network drop would. Records each renewal answer it saw.
 */
function startDroppingProxy(target: string, drops: number) {
  const state = { dropsLeft: drops, dropped: 0, renewTokens: [] as Array<string> };
  const server = NodeHttp.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const upstream = NodeHttp.request(
        new URL(req.url ?? "/", target),
        { method: req.method, headers: { ...req.headers, host: new URL(target).host } },
        (up) => {
          const body: Array<Buffer> = [];
          up.on("data", (chunk: Buffer) => body.push(chunk));
          up.on("end", () => {
            const text = Buffer.concat(body);
            if (req.url === "/api/agent-machine/renew" && up.statusCode === 200) {
              state.renewTokens.push(
                (JSON.parse(text.toString()) as { access_token: string }).access_token,
              );
              if (state.dropsLeft > 0) {
                state.dropsLeft -= 1;
                state.dropped += 1;
                req.socket.destroy();
                return;
              }
            }
            res.writeHead(up.statusCode ?? 502, up.headers);
            res.end(text);
          });
        },
      );
      upstream.on("error", () => req.socket.destroy());
      upstream.end(Buffer.concat(chunks));
    });
  });
  return new Promise<{ url: string; state: typeof state; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, state, close: () => server.close() });
    });
  });
}

describe.sequential("linked machines renew their link tokens", () => {
  let a: RunningServer;
  let b: RunningServer;

  beforeAll(async () => {
    [a, b] = await Promise.all([startServer("a"), startServer("b")]);
    expect(a.environmentId).not.toBe(b.environmentId);
  }, 120_000);

  afterAll(() => {
    for (const server of [a, b]) {
      if (server === undefined) continue;
      if (process.env.CP_LINK_RENEWAL_TEST_LOGS === "1") {
        console.log(`---- ${server.name} log ----\n${server.log.slice(-20_000)}`);
      }
      server.process.kill("SIGTERM");
      NodeFS.rmSync(server.baseDir, { recursive: true, force: true });
    }
  });

  it.live(
    "links both ways, renews both directions and outlives the first token",
    () =>
      Effect.gen(function* () {
        const { pairingUrl } = yield* pairingFrom(b, "a");
        yield* machines(a, { action: "link", pairingUrl, expectedId: b.environmentId });
        yield* machines(a, { action: "linkBack", id: b.environmentId, baseUrl: a.baseUrl });

        // The untagged machine link was renewed at once, so B tagged it with A's id.
        expect(storedToken(a, b).tagged).toBe(true);
        expect(storedToken(b, a).tagged).toBe(true);
        const firstAtoB = yield* statusOf(a, b);
        const firstBtoA = yield* statusOf(b, a);
        expect(firstAtoB.status).toBe("connected");
        expect(firstBtoA.status).toBe("connected");
        const firstExpiry = Math.max(
          Date.parse(firstAtoB.tokenExpiresAt!),
          Date.parse(firstBtoA.tokenExpiresAt!),
        );
        expect(firstExpiry - Date.now()).toBeLessThanOrEqual(TTL_SECONDS * 1000);

        // Wait until both first tokens are past expiry, then the link must still work both ways.
        yield* pause(Math.max(0, firstExpiry - Date.now()) + 3_000);
        const laterAtoB = yield* statusOf(a, b);
        const laterBtoA = yield* statusOf(b, a);
        for (const [status, first] of [
          [laterAtoB, firstAtoB],
          [laterBtoA, firstBtoA],
        ] as const) {
          expect(status.status).toBe("connected");
          expect(status.tokenRenewedAt).toBeDefined();
          expect(Date.parse(status.tokenExpiresAt!)).toBeGreaterThan(
            Date.parse(first.tokenExpiresAt!),
          );
          expect(Date.parse(status.tokenExpiresAt!)).toBeGreaterThan(Date.now());
        }
      }),
    120_000,
  );

  it.live(
    "stops renewal when the issuer unlinks, and relinks with one minted link",
    () =>
      Effect.gen(function* () {
        // B unlinks A: B revokes the renewed tokens it issued to A, so A's link stops working.
        yield* machines(b, { action: "unlink", id: a.environmentId });
        let refused: AgentMachineStatus | undefined;
        const deadline = Date.now() + 30_000;
        while (refused === undefined && Date.now() < deadline) {
          const status = yield* statusOf(a, b);
          if (status.status === "needs-relink") refused = status;
          else yield* pause(500);
        }
        expect(refused).toBeDefined();
        expect(refused?.status).toBe("needs-relink");

        // One click in Settings: mint on B (tagged for A), link on A with the machine pinned.
        const { pairingUrl } = yield* pairingFrom(b, "a", a);
        yield* machines(a, { action: "link", pairingUrl, expectedId: b.environmentId });
        const relinked = yield* statusOf(a, b);
        expect(relinked.status).toBe("connected");
        expect(relinked.tokenRenewal).toBeUndefined();

        // A link minted on another machine is refused when relinking a pinned one.
        const wrong = yield* pairingFrom(a, "a", a);
        const refusedLink = yield* Effect.flip(
          machines(a, {
            action: "link",
            pairingUrl: wrong.pairingUrl,
            expectedId: b.environmentId,
          }),
        );
        expect(refusedLink.detail).toContain("different machine");
      }),
    90_000,
  );

  it.live(
    "a leaked token renews at most once, its parent dies after the grace, and the holder notices",
    () =>
      Effect.gen(function* () {
        // The thief copies A's current token for B and races A to renew it.
        const leaked = storedToken(a, b).token;
        const early = yield* postRenew(b, leaked, "env-thief");
        expect(early).toEqual({ status: 409, body: { error: "too-early" } });
        let stolen: string | undefined;
        const deadline = Date.now() + 30_000;
        while (stolen === undefined && Date.now() < deadline) {
          const attempt = yield* postRenew(b, leaked, "env-thief");
          if (attempt.status === 200) stolen = attempt.body?.access_token;
          else if (attempt.body?.error !== "too-early") break;
          else yield* pause(100);
        }
        expect(stolen).toBeDefined();
        // The same token never renews twice.
        const again = yield* postRenew(b, leaked, "env-thief");
        expect(again).toEqual({ status: 409, body: { error: "already-renewed" } });
        // The parent stops working after the short grace, retired or not.
        yield* pause(2_000);
        expect(yield* shellStatus(b, leaked)).toBe(401);
        // A's own renewal is refused, and A shows that the link needs relinking.
        let status: AgentMachineStatus | undefined;
        const until = Date.now() + 30_000;
        while (Date.now() < until) {
          status = yield* statusOf(a, b);
          if (status.tokenRenewal === "stopped") break;
          yield* pause(500);
        }
        expect(status?.tokenRenewal).toBe("stopped");
        // The stolen child kept A's tag, so unlinking A on B revokes it.
        expect(yield* shellStatus(b, stolen!)).toBe(200);
        yield* machines(b, { action: "unlink", id: a.environmentId });
        expect(yield* shellStatus(b, stolen!)).toBe(401);
      }),
    90_000,
  );

  it.live(
    "a link made with a general pairing link works but never renews",
    () =>
      Effect.gen(function* () {
        const pairingUrl = yield* generalPairingFrom(b);
        yield* machines(a, { action: "link", pairingUrl, expectedId: b.environmentId });
        const status = yield* statusOf(a, b);
        expect(status.status).toBe("connected");
        expect(status.tokenRenewal).toBe("not-renewable");
        const token = storedToken(a, b).token;
        const attempt = yield* postRenew(b, token, a.environmentId);
        expect(attempt).toEqual({ status: 409, body: { error: "not-renewable" } });
      }),
    60_000,
  );

  it.live(
    "a lost renewal answer does not cost the link: the retry gets the same token",
    () =>
      Effect.gen(function* () {
        const proxy = yield* Effect.promise(() => startDroppingProxy(b.baseUrl, 1));
        try {
          const { pairingUrl } = yield* pairingFrom(b, "a", a);
          yield* machines(a, {
            action: "link",
            pairingUrl,
            baseUrl: proxy.url,
            expectedId: b.environmentId,
          });
          const first = yield* statusOf(a, b);
          const firstExpiry = Date.parse(first.tokenExpiresAt!);
          // Past the first token's expiry the link still works, though its renewal answer was lost.
          yield* pause(Math.max(0, firstExpiry - Date.now()) + 3_000);
          const later = yield* statusOf(a, b);
          expect(later.status).toBe("connected");
          expect(later.tokenRenewal).toBeUndefined();
          expect(Date.parse(later.tokenExpiresAt!)).toBeGreaterThan(firstExpiry);
          expect(proxy.state.dropped).toBe(1);
          // The retry with the old token received exactly the token whose answer was dropped.
          expect(proxy.state.renewTokens.length).toBeGreaterThanOrEqual(2);
          expect(proxy.state.renewTokens[1]).toBe(proxy.state.renewTokens[0]);
        } finally {
          proxy.close();
        }
      }),
    90_000,
  );
});
