// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalFetch:off globalFetchInEffect:off globalConsole:off - A black-box test of two real server processes in real time over plain HTTP.
/**
 * Two real servers, each with a fresh data directory, linked both ways with
 * a link token shortened to 24 seconds (test-only `CP_TEST_LINK_TOKEN_TTL_SECONDS`).
 * Proves the link renews by itself in both directions and outlives its first
 * token, that unlinking on the issuer revokes the holder's renewed access, and
 * that relinking with a link minted on the other machine restores it.
 */
import * as NodeChildProcess from "node:child_process";
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

const pairingFrom = (issuer: RunningServer, forLabel: string) =>
  rpc<{ pairingUrl: string }>(issuer, (client) =>
    client["server.agentMachinePairing"]({ baseUrl: issuer.baseUrl, label: forLabel }),
  );

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

        const firstAtoB = yield* statusOf(a, b);
        const firstBtoA = yield* statusOf(b, a);
        expect(firstAtoB.status).toBe("connected");
        expect(firstBtoA.status).toBe("connected");
        expect(firstAtoB.tokenRenewedAt).toBeUndefined();
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

        // One click in Settings: mint on B, link on A with the machine pinned.
        const { pairingUrl } = yield* pairingFrom(b, "a");
        yield* machines(a, { action: "link", pairingUrl, expectedId: b.environmentId });
        const relinked = yield* statusOf(a, b);
        expect(relinked.status).toBe("connected");
        expect(relinked.tokenRenewal).toBeUndefined();

        // A link minted on another machine is refused when relinking a pinned one.
        const wrong = yield* pairingFrom(a, "a");
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
});
