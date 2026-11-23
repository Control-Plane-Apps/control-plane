/**
 * `POST /api/agent-machine/renew` and `POST /api/agent-machine/retire`: a
 * linked machine trades its link token for a fresh one, and later gives the
 * old one up. Bearer only, like `/api/reach`, and only for a token with
 * exactly read and operate scope, so no broader client token can extend
 * itself. Renewal needs a token that still verifies: revoking it in Settings,
 * Connections or unlinking that machine here stops renewal at once.
 * Fork-owned; see docs/internals/multi-machine-agents.md.
 *
 * @module linkTokenRoute
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { bearerOnly } from "../reach/route.ts";
import {
  isLinkTokenScopes,
  LINK_RENEW_ROUTE_PATH,
  LINK_RETIRE_ROUTE_PATH,
  linkTokenSubject,
  linkTokenTtl,
} from "./linkToken.ts";

const RenewRequest = Schema.Struct({
  /** The holder's environment id; tags the new session so unlinking it here revokes it. */
  environmentId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/)),
});
const decodeRenewRequest = Schema.decodeUnknownOption(Schema.fromJsonString(RenewRequest));

export interface RenewedLinkToken {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
}

/** The session behind a link token on this request, or the response to send instead. */
const authenticateLinkToken = Effect.gen(function* () {
  const request = bearerOnly(yield* HttpServerRequest.HttpServerRequest);
  if (request === null) {
    return { reject: HttpServerResponse.text("Unauthorized", { status: 401 }) } as const;
  }
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth
    .authenticateHttpRequest(request)
    .pipe(Effect.orElseSucceed(() => null));
  if (session === null) {
    return { reject: HttpServerResponse.text("Unauthorized", { status: 401 }) } as const;
  }
  if (session.method !== "bearer-access-token" || !isLinkTokenScopes(session.scopes)) {
    return { reject: HttpServerResponse.text("Forbidden", { status: 403 }) } as const;
  }
  return { auth, request, session } as const;
});

/** @internal Exported for tests. */
export const renew = Effect.gen(function* () {
  const authenticated = yield* authenticateLinkToken;
  if ("reject" in authenticated) return authenticated.reject;
  const { auth, request, session } = authenticated;
  const body = decodeRenewRequest(yield* request.text.pipe(Effect.orElseSucceed(() => "")));
  if (Option.isNone(body)) return HttpServerResponse.text("Bad Request", { status: 400 });
  // Keep the label the user sees in Settings, Connections, so the renewed token reads as the same link.
  const label = yield* auth.listSessions().pipe(
    Effect.map(
      (sessions) =>
        sessions.find((candidate) => candidate.sessionId === session.sessionId)?.client.label,
    ),
    Effect.orElseSucceed(() => undefined),
  );
  const ttl = linkTokenTtl();
  const issued = yield* auth
    .issueSession({
      subject: linkTokenSubject(body.value.environmentId),
      scopes: session.scopes,
      label: label ?? "Linked machine",
      ttl,
    })
    .pipe(Effect.orElseSucceed(() => null));
  if (issued === null) return HttpServerResponse.text("Could not renew", { status: 500 });
  return HttpServerResponse.jsonUnsafe({
    access_token: issued.token,
    token_type: "Bearer",
    expires_in: Math.floor(Duration.toSeconds(ttl)),
  } satisfies RenewedLinkToken);
});

/** @internal Exported for tests. */
export const retire = Effect.gen(function* () {
  const authenticated = yield* authenticateLinkToken;
  if ("reject" in authenticated) return authenticated.reject;
  const revoked = yield* authenticated.auth
    .revokeSession(authenticated.session.sessionId)
    .pipe(Effect.orElseSucceed(() => false));
  return HttpServerResponse.jsonUnsafe({ revoked });
});

export const linkTokenRouteLayer = Layer.mergeAll(
  HttpRouter.add("POST", LINK_RENEW_ROUTE_PATH, renew),
  HttpRouter.add("POST", LINK_RETIRE_ROUTE_PATH, retire),
);
