/**
 * HTTP client for the synced task store. Plain promises over an injectable
 * fetch so tests run against an in-memory fake. Errors surface as
 * TaskSyncCloudError reasons; their user copy lives in TaskSyncError.
 */
import { createHmac, randomBytes } from "node:crypto";

import type { TaskSyncErrorReason, TaskSyncSubscription } from "@t3tools/contracts";

import type { TaskSyncConfig } from "./config.ts";
import type {
  LuciveWireMembership,
  LuciveWirePeriod,
  LuciveWireTask,
} from "@t3tools/shared/taskSyncRecords";

export class TaskSyncCloudError extends Error {
  constructor(
    readonly reason: TaskSyncErrorReason,
    readonly status?: number,
  ) {
    super(`task sync cloud error: ${reason}${status === undefined ? "" : ` (${status})`}`);
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
  if (status === 402 || body.error === "task_sync_inactive") return "inactive";
  if (status === 401) return body.error === "invalid_code" ? "invalid-code" : "signed-out";
  if (status === 429) return "rate-limited";
  if (status === 400) return body.error === "invalid_email" ? "invalid-email" : "server";
  return "server";
}

export function signHandshake(secret: string, keyId: string, ts: number, nonce: string): string {
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`${keyId}.${ts}.${nonce}`)
    .digest("hex");
}

export function makeTaskSyncCloudClient(
  config: TaskSyncConfig,
  fetchImpl: Fetch = (input, init) => fetch(input, init),
  nowMs: () => number = Date.now,
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
    if (!response.ok) throw new TaskSyncCloudError(reasonForStatus(response.status, body), response.status);
    return body;
  };

  const appClientToken = async (): Promise<string> => {
    if (clientToken !== null && clientToken.expiresAtMs - 30_000 > nowMs()) return clientToken.value;
    const ts = Math.floor(nowMs() / 1000);
    const nonce = randomBytes(16).toString("hex");
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

  const url = async (path: string, token: string) => {
    const body = await call(path, { method: "POST", bearer: token, body: "{}" });
    if (typeof body.url !== "string" || body.url.length === 0) throw new TaskSyncCloudError("server");
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
        body: JSON.stringify({ email, code, device: { name: deviceName, platform: "macos" } }),
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
      const status = body.status;
      return {
        status:
          status === "active" || status === "past_due" || status === "canceled"
            ? status
            : "inactive",
        ...(typeof body.currentPeriodEnd === "string"
          ? { currentPeriodEnd: body.currentPeriodEnd }
          : {}),
        ...(typeof body.cancelAtPeriodEnd === "boolean"
          ? { cancelAtPeriodEnd: body.cancelAtPeriodEnd }
          : {}),
      };
    },
    checkout: (token) => url("/api/entitlements/task-sync/checkout", token),
    portal: (token) => url("/api/entitlements/task-sync/portal", token),
    revoke: async (token) => {
      await call("/api/auth/revoke", { method: "POST", bearer: token, body: "{}" }).catch(
        () => undefined,
      );
    },
  };
}
