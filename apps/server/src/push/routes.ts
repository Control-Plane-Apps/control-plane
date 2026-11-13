/**
 * HTTP routes for iPhone notifications. Fork-owned.
 *
 * - `POST /api/push/devices`: the phone registers its APNs token. Needs a
 *   session with operate scope, like any other client write.
 * - `POST /api/push/action`: a notification button. Takes only an action token
 *   the server minted for that notification, which names one question version;
 *   the phone's native handler posts it while the app may not be running.
 *
 * @module pushRoutes
 */
import {
  AuthOrchestrationOperateScope,
  PUSH_ACTION_ROUTE_PATH,
  PUSH_DEVICES_ROUTE_PATH,
  PushActionRequest,
  PushDeviceRegistration,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { PushNotifier } from "./PushNotifier.ts";

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;
const MAX_BODY_BYTES = 8 * 1024;

const decodeRegistration = Schema.decodeUnknownOption(
  Schema.fromJsonString(PushDeviceRegistration),
);
const decodeAction = Schema.decodeUnknownOption(Schema.fromJsonString(PushActionRequest));

const readBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
  return text.length > MAX_BODY_BYTES ? "" : text;
});

export const pushDevicesRouteLayer = HttpRouter.add(
  "POST",
  PUSH_DEVICES_ROUTE_PATH,
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
    const registration = decodeRegistration(yield* readBody);
    if (registration._tag === "None") {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const notifier = yield* PushNotifier;
    yield* notifier.registerDevice(registration.value);
    return HttpServerResponse.empty({ status: 204 });
  }),
);

export const pushActionRouteLayer = HttpRouter.add(
  "POST",
  PUSH_ACTION_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = BEARER_PATTERN.exec(request.headers.authorization ?? "")?.[1];
    if (token === undefined) return HttpServerResponse.text("Unauthorized", { status: 401 });
    const body = decodeAction(yield* readBody);
    if (body._tag === "None") return HttpServerResponse.text("Bad Request", { status: 400 });
    const notifier = yield* PushNotifier;
    const outcome = yield* notifier.runAction(token, body.value.action);
    if (outcome === null) return HttpServerResponse.text("Unauthorized", { status: 401 });
    return outcome.ok
      ? HttpServerResponse.empty({ status: 204 })
      : HttpServerResponse.jsonUnsafe({ refusal: outcome.refusal }, { status: outcome.status });
  }),
);
