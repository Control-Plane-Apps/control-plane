/**
 * `POST /api/reach`: one cross-server reach op from a linked server. Needs a
 * bearer session with operate scope, which only pairing this server issues;
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
import { REACH_ROUTE_PATH, ReachRequest } from "./reachProtocol.ts";

/** Status writes and schedule prompts are the largest bodies; this leaves ample room. */
const MAX_BODY_BYTES = 64 * 1024;

const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(ReachRequest));

/** Built once with the route, so the host's services come from the server's layer. */
export const reachRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* makeReachHost;
    return HttpRouter.add("POST", REACH_ROUTE_PATH, handle(host));
  }),
).pipe(Layer.provide(ReachHostDependencies));

const handle = (host: ReachHostShape) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth
      .authenticateHttpRequest(request)
      .pipe(Effect.orElseSucceed(() => null));
    if (session === null) return HttpServerResponse.text("Unauthorized", { status: 401 });
    if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
      return HttpServerResponse.text("Forbidden", { status: 403 });
    }
    const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    const body = text.length > MAX_BODY_BYTES ? Option.none() : decodeRequest(text);
    if (Option.isNone(body)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const response = yield* host.handle(body.value);
    return HttpServerResponse.jsonUnsafe(response);
  });
