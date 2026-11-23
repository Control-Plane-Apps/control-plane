import { AuthSessionId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { mintRelinkPairing, revokeIssuedLinkTokens } from "./linkTokenIssuer.ts";

type Auth = EnvironmentAuth.EnvironmentAuth["Service"];

const fakeAuth = () => {
  const minted: Array<{ subject?: string; scopes?: ReadonlyArray<string> }> = [];
  const revoked: Array<string> = [];
  const auth = {
    createPairingLink: (input?: { subject?: string; scopes?: ReadonlyArray<string> }) =>
      Effect.sync(() => {
        minted.push({
          ...(input?.subject ? { subject: input.subject } : {}),
          ...(input?.scopes ? { scopes: input.scopes } : {}),
        });
        return {
          id: "pairing",
          credential: "CRED123",
          scopes: [],
          subject: input?.subject ?? "",
          createdAt: DateTime.makeUnsafe(0),
          expiresAt: DateTime.makeUnsafe(0),
        };
      }),
    listSessions: () =>
      Effect.succeed(
        ["agent-machine:env-a", "agent-machine:env-b", "agent-machine-link", "one-time-token"].map(
          (subject, index) => ({ sessionId: AuthSessionId.make(`s${index}`), subject }),
        ),
      ),
    revokeSession: (sessionId: string) =>
      Effect.sync(() => {
        revoked.push(sessionId);
        return true;
      }),
  } as unknown as Auth;
  return { auth, minted, revoked };
};

describe("machine link issuing", () => {
  it.effect("tags a relink pairing link with the holder, and an anonymous one as untagged", () =>
    Effect.gen(function* () {
      const { auth, minted } = fakeAuth();
      const tagged = yield* mintRelinkPairing(auth, {
        baseUrl: "http://100.64.0.2:3773",
        label: "MacBook",
        holderId: "env-a",
      });
      expect(tagged.pairingUrl).toBe("http://100.64.0.2:3773/pair#token=CRED123");
      yield* mintRelinkPairing(auth, { baseUrl: "http://100.64.0.2:3773", label: "MacBook" });
      expect(minted).toEqual([
        { subject: "agent-machine:env-a", scopes: ["orchestration:read", "orchestration:operate"] },
        { subject: "agent-machine-link", scopes: ["orchestration:read", "orchestration:operate"] },
      ]);
    }),
  );

  it.effect("unlinking revokes only the tokens tagged for that machine", () =>
    Effect.gen(function* () {
      const { auth, revoked } = fakeAuth();
      expect(yield* revokeIssuedLinkTokens(auth, "env-a")).toBe(1);
      expect(revoked).toEqual(["s0"]);
    }),
  );
});
