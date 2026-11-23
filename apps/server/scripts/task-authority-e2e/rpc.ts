// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off - a test script, plain Node.
// Calls one WebSocket RPC on a running test server with an operator bearer:
//   node rpc.ts <baseUrl> <token> <method> [json-input]
// Prints the result as JSON. Used by run.sh; never point it at a real server.
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

const [baseUrl, token, method, rawInput] = process.argv.slice(2);
const ticketResponse = await fetch(`${baseUrl}/api/auth/websocket-ticket`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: "{}",
});
const { ticket } = (await ticketResponse.json()) as { ticket: string };
const wsUrl = `${baseUrl!.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}`;
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
const input = rawInput === undefined ? undefined : JSON.parse(rawInput);
const result = await Effect.runPromise(
  RpcClient.make(WsRpcGroup).pipe(
    Effect.flatMap((client) =>
      (client as unknown as Record<string, (input: unknown) => Effect.Effect<unknown, Error>>)[
        method!
      ]!(input),
    ),
    Effect.scoped,
    Effect.provide(protocol),
  ),
);
console.log(JSON.stringify(result, null, 2));
process.exit(0);
