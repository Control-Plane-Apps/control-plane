/**
 * The token an iPhone notification carries for its action buttons. Fork-owned.
 *
 * The server mints one per notification and signs it with its own
 * `push-action-key`, so it verifies nowhere else and no session token verifies
 * here. It names exactly one thing: one version of one Status question, or one
 * task. A leaked token can at most send that one answer, and only while that
 * question version is still open (the decider refuses any other).
 *
 * @module actionToken
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";

export const PUSH_ACTION_SIGNING_SECRET = "push-action-key";
/** Long enough to answer a question from last night's notification. */
export const PUSH_ACTION_TOKEN_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const StatusAnswerClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("push-status-answer"),
  projectId: Schema.String,
  statusId: Schema.String,
  openedAt: Schema.String,
  iat: Schema.Number,
  exp: Schema.Number,
});
const TaskCompleteClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("push-task-complete"),
  taskId: Schema.String,
  iat: Schema.Number,
  exp: Schema.Number,
});
const PushActionClaims = Schema.Union([StatusAnswerClaims, TaskCompleteClaims]);
export type PushActionClaims = typeof PushActionClaims.Type;
export type PushActionTarget =
  | Omit<typeof StatusAnswerClaims.Type, "v" | "iat" | "exp">
  | Omit<typeof TaskCompleteClaims.Type, "v" | "iat" | "exp">;

const claimsJson = Schema.fromJsonString(PushActionClaims);
const encodeClaims = Schema.encodeSync(claimsJson);
const decodeClaims = Schema.decodeUnknownOption(claimsJson);

export function issuePushActionToken(
  target: PushActionTarget,
  secret: Uint8Array,
  nowMs: number,
): string {
  const payload = base64UrlEncode(
    encodeClaims({ ...target, v: 1, iat: nowMs, exp: nowMs + PUSH_ACTION_TOKEN_TTL_MS }),
  );
  return `${payload}.${signPayload(payload, secret)}`;
}

/** The claims of a current, correctly signed action token, or null. */
export function verifyPushActionToken(
  token: string,
  secret: Uint8Array,
  nowMs: number,
): PushActionClaims | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  if (!timingSafeEqualBase64Url(signature, signPayload(payload, secret))) return null;
  let json: string;
  try {
    json = base64UrlDecodeUtf8(payload);
  } catch {
    return null;
  }
  const claims = Option.getOrNull(decodeClaims(json));
  if (
    claims === null ||
    claims.exp <= nowMs ||
    claims.exp - claims.iat > PUSH_ACTION_TOKEN_TTL_MS ||
    claims.iat > nowMs + 60_000
  ) {
    return null;
  }
  return claims;
}
