import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const LINK_SCOPES = ["orchestration:read", "orchestration:operate"] as const;

const layer = SessionStore.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("issuer")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-link-renewal-test-" })),
);

const issueLink = (
  subject: string,
  scopes: ReadonlyArray<string> = LINK_SCOPES,
  method: "bearer-access-token" | "browser-session-cookie" = "bearer-access-token",
) =>
  Effect.gen(function* () {
    const store = yield* SessionStore.SessionStore;
    return yield* store.issue({
      subject,
      method,
      scopes: scopes as never,
      client: { label: "Agent placement from MacBook", deviceType: "bot" },
      ttl: Duration.days(30),
    });
  });

const renew = (
  sessionId: SessionStore.IssuedSession["sessionId"],
  holderId = "env-macbook",
  requestId?: string,
) =>
  Effect.gen(function* () {
    const store = yield* SessionStore.SessionStore;
    return yield* store.renewLink({
      sessionId,
      holderId,
      ttl: Duration.days(30),
      ...(requestId === undefined ? {} : { requestId }),
    });
  });

const verifies = (token: string) =>
  Effect.gen(function* () {
    const store = yield* SessionStore.SessionStore;
    return yield* store.verify(token).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  });

it.layer(NodeServices.layer)("SessionStore.renewLink", (it) => {
  it.effect("refuses a tagged token while more than 10 days remain", () =>
    Effect.gen(function* () {
      const parent = yield* issueLink("agent-machine:env-macbook");
      yield* TestClock.adjust(Duration.days(19));
      expect(yield* renew(parent.sessionId)).toEqual({ _tag: "Refused", reason: "too-early" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "renews once inside the window: the child keeps the parent's tag, the parent ends after a short grace",
    () =>
      Effect.gen(function* () {
        const parent = yield* issueLink("agent-machine:env-macbook");
        yield* TestClock.adjust(Duration.days(21));
        // A different id in the body cannot retag a tagged token.
        const outcome = yield* renew(parent.sessionId, "env-attacker");
        expect(outcome).toMatchObject({ _tag: "Renewed" });
        if (outcome._tag !== "Renewed") return;
        const store = yield* SessionStore.SessionStore;
        const child = yield* store.verify(outcome.issued.token);
        expect(child.subject).toBe("agent-machine:env-macbook");
        expect(child.scopes).toEqual(LINK_SCOPES);
        // The parent works through the grace, then stops, without anyone retiring it.
        expect(yield* verifies(parent.token)).toBe(true);
        yield* TestClock.adjust("119 seconds");
        expect(yield* verifies(parent.token)).toBe(true);
        yield* TestClock.adjust("2 seconds");
        expect(yield* verifies(parent.token)).toBe(false);
        expect(yield* verifies(outcome.issued.token)).toBe(true);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a renewal from a token whose child is gone", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      const parent = yield* issueLink("agent-machine:env-macbook");
      yield* TestClock.adjust(Duration.days(21));
      const first = yield* renew(parent.sessionId);
      if (first._tag !== "Renewed") throw new Error("not renewed");
      yield* store.revoke(first.issued.sessionId);
      expect(yield* renew(parent.sessionId)).toEqual({
        _tag: "Refused",
        reason: "already-renewed",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "a retry of the same request inside the grace gets the same child back; any other is refused",
    () =>
      Effect.gen(function* () {
        const store = yield* SessionStore.SessionStore;
        const parent = yield* issueLink("agent-machine:env-macbook");
        yield* TestClock.adjust(Duration.days(21));
        const first = yield* renew(parent.sessionId, "env-macbook", "request-aaaaaaaaaaaaaaaa");
        // The answer was lost: the holder retries a few seconds later with the old token.
        yield* TestClock.adjust("5 seconds");
        const retry = yield* renew(parent.sessionId, "env-macbook", "request-aaaaaaaaaaaaaaaa");
        // A second copy of the token, with its own request or none, is refused: the holder notices.
        expect(yield* renew(parent.sessionId, "env-macbook", "request-bbbbbbbbbbbbbbbb")).toEqual({
          _tag: "Refused",
          reason: "already-renewed",
        });
        expect(yield* renew(parent.sessionId)).toEqual({
          _tag: "Refused",
          reason: "already-renewed",
        });
        expect(first._tag).toBe("Renewed");
        expect(retry._tag).toBe("Renewed");
        if (first._tag !== "Renewed" || retry._tag !== "Renewed") return;
        expect(retry.issued.token).toBe(first.issued.token);
        expect(retry.issued.sessionId).toBe(first.issued.sessionId);
        expect((yield* store.verify(retry.issued.token)).subject).toBe("agent-machine:env-macbook");
        expect(
          (yield* store.listActive()).filter((s) => s.subject === "agent-machine:env-macbook"),
        ).toHaveLength(2);
        // Once the child is revoked, a retry gets nothing.
        yield* store.revoke(first.issued.sessionId);
        expect(yield* renew(parent.sessionId, "env-macbook", "request-aaaaaaaaaaaaaaaa")).toEqual({
          _tag: "Refused",
          reason: "already-renewed",
        });
        // After the grace the old token is dead, so no retry can reach the child either.
        yield* TestClock.adjust("2 minutes");
        expect(yield* verifies(parent.token)).toBe(false);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("an untagged machine link renews at once and is tagged with the holder", () =>
    Effect.gen(function* () {
      const parent = yield* issueLink("agent-machine-link");
      const outcome = yield* renew(parent.sessionId, "env-macbook");
      expect(outcome._tag).toBe("Renewed");
      if (outcome._tag !== "Renewed") return;
      const store = yield* SessionStore.SessionStore;
      expect((yield* store.verify(outcome.issued.token)).subject).toBe("agent-machine:env-macbook");
      // The tagged child cannot renew again early.
      expect(yield* renew(outcome.issued.sessionId)).toEqual({
        _tag: "Refused",
        reason: "too-early",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("an untagged link with an unusable holder id is refused", () =>
    Effect.gen(function* () {
      const parent = yield* issueLink("agent-machine-link");
      expect(yield* renew(parent.sessionId, "bad id/with spaces")).toEqual({
        _tag: "Refused",
        reason: "not-renewable",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("no other client token renews: general subject, broader scopes, cookies, revoked", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore.SessionStore;
      const general = yield* issueLink("one-time-token");
      const broad = yield* issueLink("agent-machine-link", [...LINK_SCOPES, "access:write"]);
      const cookie = yield* issueLink("agent-machine-link", LINK_SCOPES, "browser-session-cookie");
      const revoked = yield* issueLink("agent-machine-link");
      yield* store.revoke(revoked.sessionId);
      for (const session of [general, broad, cookie, revoked]) {
        expect(yield* renew(session.sessionId)).toEqual({
          _tag: "Refused",
          reason: "not-renewable",
        });
      }
    }).pipe(Effect.provide(layer)),
  );
});
