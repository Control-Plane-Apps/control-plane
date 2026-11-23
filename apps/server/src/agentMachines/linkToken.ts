/**
 * Lifetime and renewal timing of a linked machine's bearer token. A link
 * stays up while both machines are online: the holder renews its token well
 * before it expires, using the token itself, so a revoked or unlinked token
 * stops renewing at once and a lost machine loses access when its last token
 * runs out. Fork-owned; see docs/internals/multi-machine-agents.md.
 *
 * @module linkToken
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";

/** Path a holder posts its current token to for a fresh one. */
export const LINK_RENEW_ROUTE_PATH = "/api/agent-machine/renew";
/** Path a holder posts a token to once it no longer needs it; revokes that token only. */
export const LINK_RETIRE_ROUTE_PATH = "/api/agent-machine/retire";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long one link token lasts. Matches the session default, so links from 0.0.91 behave the same. */
export const LINK_TOKEN_TTL = Duration.days(30);
/** Renew once this much or less is left, at the latest. */
const RENEW_WINDOW_MS = 10 * DAY_MS;
/** The longest the renewer sleeps between looks, so a clock jump or a new link is noticed. */
export const MAX_RENEWAL_SLEEP_MS = 60 * 60 * 1000;
const MAX_RETRY_MS = 60 * 60 * 1000;
const BASE_RETRY_MS = 60 * 1000;
/** The old token keeps working this long after the new one is stored, for calls already in flight. */
const RETIRE_GRACE_MS = 2 * 60 * 1000;

/**
 * Test-only: a shorter token lifetime, in seconds, so an integration test can
 * watch a link outlive its first token. Ignored when unset or not a positive
 * number. Never set in a shipped build.
 */
export const TEST_LINK_TOKEN_TTL_ENV = "CP_TEST_LINK_TOKEN_TTL_SECONDS";

function testTtlSeconds(env: Record<string, string | undefined>): number | null {
  const raw = env[TEST_LINK_TOKEN_TTL_ENV];
  const seconds = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** The lifetime this server gives a link token it issues. */
export function linkTokenTtl(
  env: Record<string, string | undefined> = process.env,
): Duration.Duration {
  const seconds = testTtlSeconds(env);
  return seconds === null ? LINK_TOKEN_TTL : Duration.seconds(seconds);
}

/** Whether the lifetime was shortened for a test, so an initial pairing exchange uses it too. */
export function hasTestLinkTokenTtl(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return testTtlSeconds(env) !== null;
}

/** The scopes a link token carries: exactly read and operate. Nothing broader can renew itself. */
export function isLinkTokenScopes(scopes: ReadonlyArray<AuthEnvironmentScope>): boolean {
  return (
    scopes.length === 2 &&
    scopes.includes(AuthOrchestrationReadScope) &&
    scopes.includes(AuthOrchestrationOperateScope)
  );
}

/** Session subject of a link token whose holder is known, so unlinking on the issuer can revoke it. */
export const linkTokenSubject = (holderEnvironmentId: string): string =>
  `${LINK_SUBJECT_PREFIX}${holderEnvironmentId}`;

const LINK_SUBJECT_PREFIX = "agent-machine:";
/**
 * Subject of a link token minted for "a machine" before the holder is known:
 * a machine link created in Settings or with `t3 pair --machine-link`, and
 * links from 0.0.91 tagged by migration 59. Its first renewal names the holder.
 */
export const UNTAGGED_LINK_SUBJECT = "agent-machine-link";

/** The holder a tagged link subject names, or null for any other subject. */
export function linkSubjectHolder(subject: string): string | null {
  return subject.startsWith(LINK_SUBJECT_PREFIX) && subject.length > LINK_SUBJECT_PREFIX.length
    ? subject.slice(LINK_SUBJECT_PREFIX.length)
    : null;
}

/** Only tokens from a pairing link made for machine linking may renew; any other client token may not. */
export function isRenewableLinkSubject(subject: string): boolean {
  return subject === UNTAGGED_LINK_SUBJECT || linkSubjectHolder(subject) !== null;
}

/** Why the issuer refused a renewal; the holder acts on each differently. */
export const LinkRenewRefusal = {
  /** More than the renewal window is left: the holder renews later. */
  tooEarly: "too-early",
  /** This token already renewed once: a second holder of the same token, or a lost answer. */
  alreadyRenewed: "already-renewed",
  /** Not a machine-link token (a general pairing link or another client): it never renews. */
  notRenewable: "not-renewable",
} as const;
export type LinkRenewRefusal = (typeof LinkRenewRefusal)[keyof typeof LinkRenewRefusal];

/** Holder ids are environment ids: kept to a safe charset since they end up in a session subject. */
export const LINK_HOLDER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** A token stored before renewal existed has no issue time: assume the full lifetime. */
export function tokenLifetimeMs(input: {
  readonly issuedAtMs: number | undefined;
  readonly expiresAtMs: number;
}): number {
  const assumed = Duration.toMillis(LINK_TOKEN_TTL);
  if (input.issuedAtMs === undefined) return assumed;
  const lifetime = input.expiresAtMs - input.issuedAtMs;
  return lifetime > 0 ? lifetime : assumed;
}

/** How far ahead of expiry to renew: 10 days, or a third of a shorter lifetime. */
export function renewWindowMs(lifetimeMs: number): number {
  return Math.min(RENEW_WINDOW_MS, Math.floor(lifetimeMs / 3));
}

/** When a token falls due for renewal. */
export function renewalDueAtMs(input: {
  readonly issuedAtMs: number | undefined;
  readonly expiresAtMs: number;
}): number {
  return input.expiresAtMs - renewWindowMs(tokenLifetimeMs(input));
}

/**
 * Wait before retry `failures` (1 for the first failure): doubling from a
 * minute up to an hour, scaled down for short test lifetimes, and never past
 * the token's expiry, so a machine that comes back just before it gets one
 * more try.
 */
export function retryDelayMs(input: {
  readonly failures: number;
  readonly lifetimeMs: number;
  readonly nowMs: number;
  readonly expiresAtMs: number;
}): number {
  const window = renewWindowMs(input.lifetimeMs);
  const base = Math.max(250, Math.min(BASE_RETRY_MS, Math.floor(window / 20)));
  const cap = Math.max(base, Math.min(MAX_RETRY_MS, Math.floor(window / 4)));
  const exponent = Math.min(Math.max(input.failures - 1, 0), 20);
  const delay = Math.min(cap, base * 2 ** exponent);
  const untilExpiry = input.expiresAtMs - input.nowMs;
  return untilExpiry > base ? Math.min(delay, untilExpiry - base) : delay;
}

/** Clock skew the issuer allows on the renewal window: five minutes, less for a short lifetime. */
export function renewSkewMs(lifetimeMs: number): number {
  return Math.min(5 * 60 * 1000, Math.floor(lifetimeMs / 20));
}

/**
 * Whether the issuer lets a token renew now: a tagged token only inside its
 * renewal window (plus skew); an untagged one at once, since its first renewal
 * is what names the holder.
 */
export function issuerAllowsRenewal(input: {
  readonly subject: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly nowMs: number;
}): boolean {
  if (input.subject === UNTAGGED_LINK_SUBJECT) return true;
  const lifetimeMs = tokenLifetimeMs({
    issuedAtMs: input.issuedAtMs,
    expiresAtMs: input.expiresAtMs,
  });
  return input.expiresAtMs - input.nowMs <= renewWindowMs(lifetimeMs) + renewSkewMs(lifetimeMs);
}

/** How long the old token stays valid after renewal: two minutes, or less for a short lifetime. */
export function retireGraceMs(lifetimeMs: number): number {
  return Math.min(RETIRE_GRACE_MS, Math.floor(lifetimeMs / 20));
}
