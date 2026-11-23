import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";

import {
  hasTestLinkTokenTtl,
  isLinkTokenScopes,
  linkTokenTtl,
  renewalDueAtMs,
  renewWindowMs,
  retireGraceMs,
  retryDelayMs,
  TEST_LINK_TOKEN_TTL_ENV,
  tokenLifetimeMs,
} from "./linkToken.ts";

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

describe("link token timing", () => {
  it("renews a 30 day token with 10 days left", () => {
    const issuedAtMs = 0;
    const expiresAtMs = 30 * DAY;
    expect(renewalDueAtMs({ issuedAtMs, expiresAtMs })).toBe(20 * DAY);
  });

  it("assumes 30 days for a token stored before renewal (no issue time)", () => {
    expect(tokenLifetimeMs({ issuedAtMs: undefined, expiresAtMs: 5 * DAY })).toBe(30 * DAY);
    expect(renewalDueAtMs({ issuedAtMs: undefined, expiresAtMs: 40 * DAY })).toBe(30 * DAY);
  });

  it("renews a short test token a third of the way before expiry", () => {
    expect(renewWindowMs(24_000)).toBe(8_000);
    expect(renewalDueAtMs({ issuedAtMs: 0, expiresAtMs: 24_000 })).toBe(16_000);
  });

  it("backs off from a minute, doubling, capped at an hour", () => {
    const timing = { lifetimeMs: 30 * DAY, nowMs: 20 * DAY, expiresAtMs: 30 * DAY };
    expect(retryDelayMs({ failures: 1, ...timing })).toBe(MIN);
    expect(retryDelayMs({ failures: 2, ...timing })).toBe(2 * MIN);
    expect(retryDelayMs({ failures: 3, ...timing })).toBe(4 * MIN);
    expect(retryDelayMs({ failures: 12, ...timing })).toBe(60 * MIN);
    expect(retryDelayMs({ failures: 500, ...timing })).toBe(60 * MIN);
  });

  it("never waits past expiry, so a machine back just in time gets one more try", () => {
    const expiresAtMs = 30 * DAY;
    const nowMs = expiresAtMs - 3 * MIN;
    expect(retryDelayMs({ failures: 10, lifetimeMs: 30 * DAY, nowMs, expiresAtMs })).toBe(2 * MIN);
  });

  it("scales the backoff down for a short test lifetime", () => {
    const timing = { lifetimeMs: 24_000, nowMs: 16_000, expiresAtMs: 24_000 };
    expect(retryDelayMs({ failures: 1, ...timing })).toBe(400);
    expect(retryDelayMs({ failures: 5, ...timing })).toBe(2_000);
  });

  it("keeps the old token two minutes after renewal, less for a short lifetime", () => {
    expect(retireGraceMs(30 * DAY)).toBe(2 * MIN);
    expect(retireGraceMs(24_000)).toBe(1_200);
  });
});

describe("link token policy", () => {
  it("lasts 30 days unless a test shortens it", () => {
    expect(Duration.toMillis(linkTokenTtl({}))).toBe(30 * DAY);
    expect(hasTestLinkTokenTtl({})).toBe(false);
    expect(Duration.toMillis(linkTokenTtl({ [TEST_LINK_TOKEN_TTL_ENV]: "24" }))).toBe(24_000);
    expect(hasTestLinkTokenTtl({ [TEST_LINK_TOKEN_TTL_ENV]: "24" })).toBe(true);
    expect(hasTestLinkTokenTtl({ [TEST_LINK_TOKEN_TTL_ENV]: "nope" })).toBe(false);
    expect(hasTestLinkTokenTtl({ [TEST_LINK_TOKEN_TTL_ENV]: "-5" })).toBe(false);
  });

  it("lets only a read-and-operate token renew itself", () => {
    expect(isLinkTokenScopes(["orchestration:read", "orchestration:operate"])).toBe(true);
    expect(isLinkTokenScopes(["orchestration:operate", "orchestration:read"])).toBe(true);
    expect(isLinkTokenScopes(["orchestration:read"])).toBe(false);
    expect(isLinkTokenScopes(["orchestration:read", "orchestration:operate", "access:write"])).toBe(
      false,
    );
  });
});
