/**
 * `POST /api/reach`: one cross-server reach op from a linked server. Needs a
 * bearer token (never a cookie) with operate scope, which only pairing this server issues;
 * that token can already dispatch any client command, so the route adds no
 * power, only the server-only writes the Assistant's tools make locally.
 * Fork-owned; see docs/internals/assistant-cross-server-reach.md.
 *
 * @module reachRoute
 */
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { make as makeReachHost, ReachHostDependencies, type ReachHostShape } from "./ReachHost.ts";
import {
  REACH_MAX_BODY_BYTES,
  REACH_ROUTE_PATH,
  ReachRequest,
  reachBodyLimit,
} from "./reachProtocol.ts";

const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(ReachRequest));
const BEARER_PATTERN = /^Bearer\s+\S+$/i;

/**
 * The request as the route authenticates it: only a bearer token counts.
 * Browser session cookies are dropped, because every localhost port is the
 * same site for SameSite=Lax, so any local page could otherwise send ops.
 * Null when there is no bearer token.
 */
export function bearerOnly(
  request: HttpServerRequest.HttpServerRequest,
): HttpServerRequest.HttpServerRequest | null {
  if (!BEARER_PATTERN.test(request.headers.authorization ?? "")) return null;
  const { cookie: _cookie, ...headers } = request.headers;
  return request.modify({ headers: headers as typeof request.headers });
}

/** Built once with the route, so the host's services come from the server's layer. */
export const reachRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* makeReachHost;
    return HttpRouter.add("POST", REACH_ROUTE_PATH, handle(host));
  }),
).pipe(Layer.provide(ReachHostDependencies));

const handle = (host: ReachHostShape) =>
  Effect.gen(function* () {
    const request = bearerOnly(yield* HttpServerRequest.HttpServerRequest);
    if (request === null) return HttpServerResponse.text("Unauthorized", { status: 401 });
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth
      .authenticateHttpRequest(request)
      .pipe(Effect.orElseSucceed(() => null));
    if (session === null) return HttpServerResponse.text("Unauthorized", { status: 401 });
    if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
      return HttpServerResponse.text("Forbidden", { status: 403 });
    }
    const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    if (text.length > REACH_MAX_BODY_BYTES) {
      return HttpServerResponse.text("Request too large", { status: 413 });
    }
    const body = decodeRequest(text);
    if (Option.isNone(body)) return HttpServerResponse.text("Bad Request", { status: 400 });
    if (text.length > reachBodyLimit(body.value.op)) {
      return HttpServerResponse.text(`Request too large for ${body.value.op}`, { status: 413 });
    }
    const response = yield* host.handle(body.value);
    return HttpServerResponse.jsonUnsafe(response);
  });
