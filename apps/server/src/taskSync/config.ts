/**
 * Task Sync's client identity. The release build bakes the key in from its
 * build environment (CPLANE_TASK_SYNC_CLIENT_KEY_ID / _SECRET, kept outside
 * the repo in the release machine's secrets and EAS secrets for iOS); a dev
 * server reads the same names from its environment. Without both, Task Sync
 * reports `unavailable` and tasks stay local.
 */
import type { TaskSyncConfig } from "@t3tools/shared/taskSync/cloudClient";

export type { TaskSyncConfig };

declare const __CPLANE_TASK_SYNC_URL__: string | undefined;
declare const __CPLANE_TASK_SYNC_CLIENT_KEY_ID__: string | undefined;
declare const __CPLANE_TASK_SYNC_CLIENT_SECRET__: string | undefined;

/** The production task store. Internal: never shown to users. */
const DEFAULT_BASE_URL = "https://mcp.lucive.app";

function pick(built: string | undefined, envName: string): string {
  const fromBuild = typeof built === "string" ? built.trim() : "";
  if (fromBuild.length > 0) return fromBuild;
  return process.env[envName]?.trim() ?? "";
}

export function readTaskSyncConfig(): TaskSyncConfig | null {
  const keyId = pick(
    typeof __CPLANE_TASK_SYNC_CLIENT_KEY_ID__ === "undefined"
      ? undefined
      : __CPLANE_TASK_SYNC_CLIENT_KEY_ID__,
    "CPLANE_TASK_SYNC_CLIENT_KEY_ID",
  );
  const secret = pick(
    typeof __CPLANE_TASK_SYNC_CLIENT_SECRET__ === "undefined"
      ? undefined
      : __CPLANE_TASK_SYNC_CLIENT_SECRET__,
    "CPLANE_TASK_SYNC_CLIENT_SECRET",
  );
  const baseUrl =
    pick(
      typeof __CPLANE_TASK_SYNC_URL__ === "undefined" ? undefined : __CPLANE_TASK_SYNC_URL__,
      "CPLANE_TASK_SYNC_URL",
    ) || DEFAULT_BASE_URL;
  if (keyId.length === 0 || !/^[0-9a-f]{64}$/i.test(secret)) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), keyId, secret };
}
