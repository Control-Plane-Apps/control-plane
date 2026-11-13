/**
 * Sends alert pushes straight to APNs over HTTP/2 with a token-based (.p8)
 * auth key. Fork-owned.
 *
 * The key lives at `<stateDir>/apns/AuthKey_<KEYID>.p8`, the name Apple gives
 * the download, so the key id comes from the file name. The team id defaults
 * to Control Plane's and can be overridden with `CP_APNS_TEAM_ID`. Without a
 * key, sending is skipped and logged once.
 *
 * @module apnsClient
 */
import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";

import type { PushApsEnvironment } from "@t3tools/contracts";

export const DEFAULT_APNS_TEAM_ID = "37FM6MWUPG";
const KEY_FILE_PATTERN = /^AuthKey_([A-Z0-9]{10})\.p8$/;
/** Apple refuses provider tokens older than an hour and throttles refreshes under 20 minutes. */
const PROVIDER_TOKEN_TTL_MS = 50 * 60 * 1000;

export interface ApnsKey {
  readonly keyId: string;
  readonly teamId: string;
  readonly privateKey: NodeCrypto.KeyObject;
}

export function apnsKeyIdFromFileName(fileName: string): string | null {
  return KEY_FILE_PATTERN.exec(fileName)?.[1] ?? null;
}

export function parseApnsKey(input: {
  readonly fileName: string;
  readonly pem: string;
  readonly teamId?: string | undefined;
}): ApnsKey | null {
  const keyId = apnsKeyIdFromFileName(input.fileName);
  if (keyId === null) return null;
  try {
    return {
      keyId,
      teamId: input.teamId?.trim() || DEFAULT_APNS_TEAM_ID,
      privateKey: NodeCrypto.createPrivateKey(input.pem),
    };
  } catch {
    return null;
  }
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function makeProviderToken(key: ApnsKey, nowMs: number): string {
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: key.keyId }));
  const claims = base64Url(JSON.stringify({ iss: key.teamId, iat: Math.floor(nowMs / 1000) }));
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${claims}.${base64Url(signature)}`;
}

export function apnsHost(environment: PushApsEnvironment): string {
  return environment === "sandbox"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";
}

export interface ApnsSendInput {
  readonly deviceToken: string;
  readonly environment: PushApsEnvironment;
  readonly topic: string;
  readonly collapseId?: string;
  readonly payload: unknown;
}

export interface ApnsSendResult {
  readonly status: number;
  readonly reason?: string;
}

/** Reasons that mean the token will never work again; the device is dropped. */
export const PERMANENT_APNS_REASONS: ReadonlySet<string> = new Set([
  "BadDeviceToken",
  "Unregistered",
  "DeviceTokenNotForTopic",
  "TopicDisallowed",
]);

export interface ApnsClient {
  readonly send: (input: ApnsSendInput) => Promise<ApnsSendResult>;
  readonly close: () => void;
}

export function makeApnsClient(key: ApnsKey, now: () => number = Date.now): ApnsClient {
  const sessions = new Map<string, NodeHttp2.ClientHttp2Session>();
  let cached: { token: string; at: number } | null = null;

  const providerToken = () => {
    const nowMs = now();
    if (cached === null || nowMs - cached.at > PROVIDER_TOKEN_TTL_MS) {
      cached = { token: makeProviderToken(key, nowMs), at: nowMs };
    }
    return cached.token;
  };

  const session = (host: string) => {
    const existing = sessions.get(host);
    if (existing !== undefined && !existing.closed && !existing.destroyed) return existing;
    const created = NodeHttp2.connect(host);
    created.on("error", () => sessions.delete(host));
    created.on("close", () => sessions.delete(host));
    // Idle connections close on their own; APNs prefers one long-lived one,
    // but a laptop sleeps and a dead socket is worse than a reconnect.
    created.setTimeout(10 * 60 * 1000, () => created.close());
    created.unref();
    sessions.set(host, created);
    return created;
  };

  const send = (input: ApnsSendInput) =>
    new Promise<ApnsSendResult>((resolve, reject) => {
      let request: NodeHttp2.ClientHttp2Stream;
      try {
        request = session(apnsHost(input.environment)).request({
          ":method": "POST",
          ":path": `/3/device/${input.deviceToken}`,
          authorization: `bearer ${providerToken()}`,
          "apns-topic": input.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          ...(input.collapseId === undefined ? {} : { "apns-collapse-id": input.collapseId }),
        });
      } catch (error) {
        reject(error);
        return;
      }
      let status = 0;
      let body = "";
      request.setEncoding("utf8");
      request.setTimeout(15_000, () => request.close(NodeHttp2.constants.NGHTTP2_CANCEL));
      request.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("error", reject);
      request.on("end", () => {
        let reason: string | undefined;
        try {
          reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
        } catch {
          reason = undefined;
        }
        resolve(reason === undefined ? { status } : { status, reason });
      });
      request.end(JSON.stringify(input.payload));
    });

  return {
    send,
    close: () => {
      for (const entry of sessions.values()) entry.close();
      sessions.clear();
    },
  };
}
