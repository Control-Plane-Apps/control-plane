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
  issued: Array<{ subject?: string; scopes?: ReadonlyArray<string>; label?: string }>;
  revoked: Array<string>;
}

const makeAuth = (overrides: Partial<AuthState> = {}) => {
  const state: AuthState = {
    scopes: LINK_SCOPES,
    method: "bearer-access-token",
    valid: true,
    issued: [],
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
    listSessions: () =>
      Effect.succeed([
        {
          sessionId: SESSION_ID,
          client: { label: "Agent placement from MacBook" },
        } as never,
      ]),
    issueSession: (input) =>
      Effect.sync(() => {
        state.issued.push({
          ...(input?.subject ? { subject: input.subject } : {}),
          ...(input?.scopes ? { scopes: input.scopes } : {}),
          ...(input?.label ? { label: input.label } : {}),
        });
        return {
          sessionId: AuthSessionId.make("session-new"),
          token: "fresh-token",
          method: "bearer-access-token",
          scopes: input?.scopes ?? [],
          subject: input?.subject ?? "",
          client: { deviceType: "bot" },
          expiresAt: DateTime.makeUnsafe(0),
        } as never;
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
  it.effect("renews a link token: same scopes and label, tagged with the holder's id", () =>
    Effect.gen(function* () {
      const auth = makeAuth();
      const response = yield* call(renew, auth, { authorization: "Bearer old-token" });
      expect(response.status).toBe(200);
      expect(json(response)).toMatchObject({
        access_token: "fresh-token",
        token_type: "Bearer",
        expires_in: 30 * 24 * 60 * 60,
      });
      expect(auth.state.issued).toEqual([
        {
          subject: "agent-machine:env-macbook",
          scopes: LINK_SCOPES,
          label: "Agent placement from MacBook",
        },
      ]);
      // The old token is not revoked here: the holder retires it once the new one works.
      expect(auth.state.revoked).toEqual([]);
    }),
  );

  it.effect("refuses a cookie-only request: bearer only", () =>
    Effect.gen(function* () {
      const auth = makeAuth();
      const response = yield* call(renew, auth, { cookie: "t3_session=abc" });
      expect(response.status).toBe(401);
      expect(auth.state.issued).toEqual([]);
    }),
  );

  it.effect("refuses a revoked or expired token, so revocation stops renewal at once", () =>
    Effect.gen(function* () {
      const auth = makeAuth({ valid: false });
      const response = yield* call(renew, auth, { authorization: "Bearer revoked" });
      expect(response.status).toBe(401);
      expect(auth.state.issued).toEqual([]);
    }),
  );

  it.effect("refuses a broader client token, which must not extend itself", () =>
    Effect.gen(function* () {
      const auth = makeAuth({ scopes: [...LINK_SCOPES, "access:write"] });
      const response = yield* call(renew, auth, { authorization: "Bearer admin" });
      expect(response.status).toBe(403);
      expect(auth.state.issued).toEqual([]);
    }),
  );

  it.effect("rejects a body without the holder's id", () =>
    Effect.gen(function* () {
      const auth = makeAuth();
      const response = yield* call(renew, auth, { authorization: "Bearer old" }, "{}");
      expect(response.status).toBe(400);
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
