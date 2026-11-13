// @effect-diagnostics globalFetch:off - a small promise client with an injectable fetch, so tests run against an in-memory fake without an HTTP layer.
/**
 * HTTP client for the synced task store. Plain promises over an injectable
 * fetch so tests run against an in-memory fake. Errors surface as
 * TaskSyncCloudError reasons; their user copy lives in TaskSyncError.
 */
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";

import type { TaskSyncErrorReason, TaskSyncSubscription } from "@t3tools/contracts";

import type { LuciveWireMembership, LuciveWirePeriod, LuciveWireTask } from "../taskSyncRecords.ts";

export interface TaskSyncConfig {
  readonly baseUrl: string;
  readonly keyId: string;
  readonly secret: string;
}

/** Which app is calling: the device platform sent at sign-in and the checkout return. */
export interface TaskSyncClientInfo {
  readonly platform: "macos" | "ios";
  readonly returnTo: "desktop" | "mobile";
  /** 16 random bytes; defaults to Web Crypto, which React Native may lack. */
  readonly randomBytes?: (length: number) => Uint8Array;
}

const DESKTOP_CLIENT: TaskSyncClientInfo = { platform: "macos", returnTo: "desktop" };

export class TaskSyncCloudError extends Error {
  readonly reason: TaskSyncErrorReason;
  readonly status: number | undefined;
  constructor(reason: TaskSyncErrorReason, status?: number) {
    super(`task sync cloud error: ${reason}${status === undefined ? "" : ` (${status})`}`);
    this.reason = reason;
    this.status = status;
  }
}

export interface WireTaskWithSeq extends LuciveWireTask {
  readonly seq?: number;
  readonly entryRef?: string | null;
}

export interface WirePeriodFull extends LuciveWirePeriod {
  readonly anchorDate: string;
  readonly title: string | null;
  readonly revision: number;
  readonly createdAt: string;
}

export interface WireMembershipFull extends LuciveWireMembership {
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChangesPage {
  readonly tasks: ReadonlyArray<WireTaskWithSeq>;
  readonly periods: ReadonlyArray<WirePeriodFull>;
  readonly memberships: ReadonlyArray<WireMembershipFull>;
  readonly nextSince: number;
  readonly hasMore: boolean;
  readonly settings?: { readonly weekStartsOn?: number };
}

export interface PushBatch {
  readonly tasks: ReadonlyArray<Record<string, unknown>>;
  readonly periods: ReadonlyArray<Record<string, unknown>>;
  readonly memberships: ReadonlyArray<Record<string, unknown>>;
}

export interface PushResult {
  readonly remaps?: { readonly periods?: ReadonlyArray<{ from: string; to: string }> };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface TaskSyncCloudClient {
  readonly requestCode: (email: string) => Promise<void>;
  readonly verify: (input: {
    email: string;
    code: string;
    deviceName: string;
  }) => Promise<{ token: string; email: string }>;
  readonly changes: (token: string, since: number) => Promise<ChangesPage>;
  readonly push: (token: string, batch: PushBatch) => Promise<PushResult>;
  readonly subscription: (token: string) => Promise<TaskSyncSubscription>;
  readonly checkout: (token: string) => Promise<string>;
  readonly portal: (token: string) => Promise<string>;
  readonly revoke: (token: string) => Promise<void>;
}

function reasonForStatus(status: number, body: { error?: unknown }): TaskSyncErrorReason {
  // Any 402 from planning sync means the subscription is off
  // (`task_sync_inactive`; older drafts said `task_sync_not_active`).
  if (
    status === 402 ||
    body.error === "task_sync_inactive" ||
    body.error === "task_sync_not_active"
  ) {
    return "inactive";
  }
  if (status === 404 && body.error === "no_subscription") return "inactive";
  // Checkout not set up yet is our side; anything else at 503 is transient.
  if (status === 503) return body.error === "checkout_unavailable" ? "server" : "network";
  if (status === 401) return body.error === "invalid_code" ? "invalid-code" : "signed-out";
  if (status === 429) return "rate-limited";
  if (status === 400) return body.error === "invalid_email" ? "invalid-email" : "server";
  return "server";
}

export function signHandshake(secret: string, keyId: string, ts: number, nonce: string): string {
  return bytesToHex(hmac(sha256, hexToBytes(secret), utf8ToBytes(`${keyId}.${ts}.${nonce}`)));
}

export function makeTaskSyncCloudClient(
  config: TaskSyncConfig,
  fetchImpl: Fetch = (input, init) => fetch(input, init),
  nowMs: () => number = Date.now,
  client: TaskSyncClientInfo = DESKTOP_CLIENT,
): TaskSyncCloudClient {
  let clientToken: { value: string; expiresAtMs: number } | null = null;

  const call = async (
    path: string,
    init: RequestInit & { readonly bearer?: string; readonly appClient?: boolean } = {},
  ): Promise<Record<string, unknown>> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.bearer !== undefined) headers.authorization = `Bearer ${init.bearer}`;
    if (init.appClient === true) headers["x-lucive-client"] = await appClientToken();
    let response: Response;
    try {
      response = await fetchImpl(`${config.baseUrl}${path}`, { ...init, headers });
    } catch {
      throw new TaskSyncCloudError("network");
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok)
      throw new TaskSyncCloudError(reasonForStatus(response.status, body), response.status);
    return body;
  };

  const appClientToken = async (): Promise<string> => {
    if (clientToken !== null && clientToken.expiresAtMs - 30_000 > nowMs())
      return clientToken.value;
    const ts = Math.floor(nowMs() / 1000);
    const nonce = bytesToHex((client.randomBytes ?? randomBytes)(16));
    const body = await call("/api/client/handshake", {
      method: "POST",
      body: JSON.stringify({
        keyId: config.keyId,
        ts,
        nonce,
        sig: signHandshake(config.secret, config.keyId, ts, nonce),
      }),
    });
    const token = typeof body.token === "string" ? body.token : "";
    const expiresIn = typeof body.expiresIn === "number" ? body.expiresIn : 300;
    if (token.length === 0) throw new TaskSyncCloudError("server");
    clientToken = { value: token, expiresAtMs: nowMs() + expiresIn * 1000 };
    return token;
  };

  const url = async (path: string, token: string, payload: Record<string, unknown> = {}) => {
    const body = await call(path, { method: "POST", bearer: token, body: JSON.stringify(payload) });
    if (typeof body.url !== "string" || body.url.length === 0)
      throw new TaskSyncCloudError("server");
    return body.url;
  };

  return {
    requestCode: async (email) => {
      await call("/api/auth/request-code", {
        method: "POST",
        appClient: true,
        body: JSON.stringify({ email }),
      });
    },
    verify: async ({ email, code, deviceName }) => {
      const body = await call("/api/auth/verify", {
        method: "POST",
        appClient: true,
        body: JSON.stringify({
          email,
          code,
          device: { name: deviceName, platform: client.platform },
        }),
      });
      const token = typeof body.token === "string" ? body.token : "";
      const user = body.user as { email?: unknown } | undefined;
      if (token.length === 0) throw new TaskSyncCloudError("server");
      return { token, email: typeof user?.email === "string" ? user.email : email };
    },
    changes: async (token, since) =>
      (await call(`/api/planning/changes?since=${since}&limit=500`, {
        method: "GET",
        bearer: token,
      })) as unknown as ChangesPage,
    push: async (token, batch) =>
      (await call("/api/planning/push", {
        method: "POST",
        bearer: token,
        body: JSON.stringify(batch),
      })) as PushResult,
    subscription: async (token) => {
      const body = await call("/api/entitlements/task-sync", { method: "GET", bearer: token });
      // `past_due` still syncs during the grace period; `canceled` is off.
      const status =
        body.status === "active"
          ? "active"
          : body.status === "past_due" || body.status === "grace"
            ? "grace"
            : "inactive";
      return {
        status,
        ...(typeof body.currentPeriodEnd === "string"
          ? { currentPeriodEnd: body.currentPeriodEnd }
          : {}),
        ...(typeof body.cancelAtPeriodEnd === "boolean"
          ? { cancelAtPeriodEnd: body.cancelAtPeriodEnd }
          : {}),
        ...(typeof body.canManage === "boolean" ? { canManage: body.canManage } : {}),
      };
    },
    checkout: async (token) => {
      try {
        return await url("/api/entitlements/task-sync/checkout", token, {
          returnTo: client.returnTo,
        });
      } catch (error) {
        // Already subscribed: managing the subscription is the useful next step.
        if (error instanceof TaskSyncCloudError && error.status === 409) {
          return url("/api/entitlements/task-sync/portal", token);
        }
        throw error;
      }
    },
    portal: (token) => url("/api/entitlements/task-sync/portal", token),
    revoke: async (token) => {
      await call("/api/auth/revoke", { method: "POST", bearer: token, body: "{}" }).catch(
        () => undefined,
      );
    },
  };
}
