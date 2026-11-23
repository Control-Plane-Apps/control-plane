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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { bearerOnly } from "../reach/route.ts";
import {
  isLinkTokenScopes,
  LINK_HOLDER_ID_PATTERN,
  LINK_RENEW_ROUTE_PATH,
  LINK_RETIRE_ROUTE_PATH,
} from "./linkToken.ts";

const RenewRequest = Schema.Struct({
  /**
   * The holder's environment id. Used only when the presented token is an
   * untagged original (`agent-machine-link`); a tagged token's child keeps its tag.
   */
  environmentId: Schema.String.check(Schema.isPattern(LINK_HOLDER_ID_PATTERN)),
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

/**
 * Renews a link token at most once, only inside its renewal window (an
 * untagged original at once, to name its holder), and cuts the presenting
 * token's lifetime to a short grace: a leaked token cannot mint children
 * forever, and a second holder of the same token is refused (409
 * `already-renewed`), which the real holder sees as needing a relink.
 */
/** @internal Exported for tests. */
export const renew = Effect.gen(function* () {
  const authenticated = yield* authenticateLinkToken;
  if ("reject" in authenticated) return authenticated.reject;
  const { auth, request, session } = authenticated;
  const body = decodeRenewRequest(yield* request.text.pipe(Effect.orElseSucceed(() => "")));
  if (Option.isNone(body)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const outcome = yield* auth
    .renewLinkSession(session.sessionId, body.value.environmentId)
    .pipe(Effect.orElseSucceed(() => null));
  if (outcome === null) return HttpServerResponse.text("Could not renew", { status: 500 });
  if (outcome._tag === "Refused") {
    return HttpServerResponse.jsonUnsafe({ error: outcome.reason }, { status: 409 });
  }
  const remainingMs =
    outcome.issued.expiresAt.epochMilliseconds - (yield* DateTime.now).epochMilliseconds;
  return HttpServerResponse.jsonUnsafe({
    access_token: outcome.issued.token,
    token_type: "Bearer",
    expires_in: Math.max(0, Math.floor(remainingMs / 1000)),
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
