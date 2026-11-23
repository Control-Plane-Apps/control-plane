import { AuthSessionId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { renew, retire } from "./linkTokenRoute.ts";

const LINK_SCOPES = ["orchestration:read", "orchestration:operate"] as const;
const SESSION_ID = AuthSessionId.make("session-old");

interface AuthState {
  scopes: ReadonlyArray<string>;
  method: string;
  valid: boolean;
  renewals: Array<{ sessionId: string; holderId: string; requestId?: string }>;
  refusal: string | null;
  revoked: Array<string>;
}

const makeAuth = (overrides: Partial<AuthState> = {}) => {
  const state: AuthState = {
    scopes: LINK_SCOPES,
    method: "bearer-access-token",
    valid: true,
    renewals: [],
    refusal: null,
    revoked: [],
    ...overrides,
  };
  const layer = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: (request) =>
      state.valid && /^Bearer /.test(request.headers.authorization ?? "")
        ? Effect.succeed({
            sessionId: SESSION_ID,
            subject: "one-time-token",
            method: state.method as never,
            scopes: state.scopes as never,
          })
        : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
    renewLinkSession: (sessionId, holderId, requestId) =>
      Effect.sync(() => {
        state.renewals.push({
          sessionId,
          holderId,
          ...(requestId === undefined ? {} : { requestId }),
        });
        return state.refusal === null
          ? {
              _tag: "Renewed" as const,
              issued: {
                sessionId: AuthSessionId.make("session-new"),
                token: "fresh-token",
                method: "bearer-access-token",
                client: { deviceType: "bot" },
                scopes: LINK_SCOPES as never,
                expiresAt: DateTime.makeUnsafe(30 * 24 * 60 * 60 * 1000),
              },
            }
          : { _tag: "Refused" as const, reason: state.refusal as never };
      }),
    revokeSession: (sessionId) =>
      Effect.sync(() => {
        state.revoked.push(sessionId);
        return true;
      }),
  });
  return { state, layer };
};

const call = (
  handler: typeof renew,
  auth: ReturnType<typeof makeAuth>,
  headers: Record<string, string>,
  body = JSON.stringify({ environmentId: "env-macbook" }),
) =>
  handler.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request("http://127.0.0.1:3773/api/agent-machine/renew", {
          method: "POST",
          headers,
          body,
        }),
      ),
    ),
    Effect.provide(auth.layer),
    Effect.map((response) => response as HttpServerResponse.HttpServerResponse),
  );

const json = (response: HttpServerResponse.HttpServerResponse) =>
  JSON.parse(new TextDecoder().decode((response.body as { body: Uint8Array }).body));

describe("link token routes", () => {
  it.effect("renews through the session store with the presenting session and the holder id", () =>
    Effect.gen(function* () {
      const auth = makeAuth();
      const response = yield* call(renew, auth, { authorization: "Bearer old-token" });
      expect(response.status).toBe(200);
      expect(json(response)).toMatchObject({
        access_token: "fresh-token",
        token_type: "Bearer",
        expires_in: 30 * 24 * 60 * 60,
      });
      expect(auth.state.renewals).toEqual([{ sessionId: SESSION_ID, holderId: "env-macbook" }]);
    }),
  );

  it.effect("passes the holder's request id through, so a retry can get the same token", () =>
    Effect.gen(function* () {
      const auth = makeAuth();
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const body = JSON.stringify({
        environmentId: "env-macbook",
        requestId: "0123456789abcdef0123456789abcdef",
      });
      expect((yield* call(renew, auth, { authorization: "Bearer old" }, body)).status).toBe(200);
      expect(auth.state.renewals).toEqual([
        {
          sessionId: SESSION_ID,
          holderId: "env-macbook",
          requestId: "0123456789abcdef0123456789abcdef",
        },
      ]);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const short = JSON.stringify({ environmentId: "env-macbook", requestId: "short" });
      expect((yield* call(renew, auth, { authorization: "Bearer old" }, short)).status).toBe(400);
    }),
  );

  it.effect("answers a refusal as 409 with its reason", () =>
    Effect.gen(function* () {
      for (const reason of ["too-early", "already-renewed", "not-renewable"]) {
        const auth = makeAuth({ refusal: reason });
        const response = yield* call(renew, auth, { authorization: "Bearer old-token" });
        expect(response.status).toBe(409);
        expect(json(response)).toEqual({ error: reason });
      }
    }),
  );

  it.effect("refuses a cookie-only request: bearer only", () =>
    Effect.gen(function* () {
      const auth = makeAuth();
      const response = yield* call(renew, auth, { cookie: "t3_session=abc" });
      expect(response.status).toBe(401);
      expect(auth.state.renewals).toEqual([]);
    }),
  );

  it.effect("refuses a revoked or expired token, so revocation stops renewal at once", () =>
    Effect.gen(function* () {
      const auth = makeAuth({ valid: false });
      const response = yield* call(renew, auth, { authorization: "Bearer revoked" });
      expect(response.status).toBe(401);
      expect(auth.state.renewals).toEqual([]);
    }),
  );

  it.effect("refuses a broader client token, which must not extend itself", () =>
    Effect.gen(function* () {
      const auth = makeAuth({ scopes: [...LINK_SCOPES, "access:write"] });
      const response = yield* call(renew, auth, { authorization: "Bearer admin" });
      expect(response.status).toBe(403);
      expect(auth.state.renewals).toEqual([]);
    }),
  );

  it.effect("rejects a body without a usable holder id", () =>
    Effect.gen(function* () {
      const auth = makeAuth();
      expect((yield* call(renew, auth, { authorization: "Bearer old" }, "{}")).status).toBe(400);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const spaced = JSON.stringify({ environmentId: "has spaces/and slash" });
      expect((yield* call(renew, auth, { authorization: "Bearer old" }, spaced)).status).toBe(400);
      expect(auth.state.renewals).toEqual([]);
    }),
  );

  it.effect("retire revokes the presenting token only", () =>
    Effect.gen(function* () {
      const auth = makeAuth();
      const response = yield* call(retire, auth, { authorization: "Bearer old-token" }, "{}");
      expect(response.status).toBe(200);
      expect(auth.state.revoked).toEqual([SESSION_ID]);
    }),
  );
});
