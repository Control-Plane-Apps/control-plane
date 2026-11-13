import {
  TaskSyncError,
  type Task,
  type TaskHorizon,
  type TaskId,
  type TaskIntent,
  type TaskPatch,
  type TaskSyncStatus,
} from "@t3tools/contracts";
import {
  makeTaskSyncCloudClient,
  TaskSyncCloudError,
  type TaskSyncConfig,
} from "@t3tools/shared/taskSync/cloudClient";
import {
  emptyTaskSyncState,
  TaskSyncEngine,
  type TaskSyncApply,
  type TaskSyncPersistedState,
} from "@t3tools/shared/taskSync/engine";
import {
  createLocalTask,
  patchLocalTask,
  type LocalTaskInput,
} from "@t3tools/shared/taskSync/localTasks";
import Constants from "expo-constants";
import * as ExpoCrypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";

import { uuidv4 } from "../../lib/uuid";

// Fork-owned. The phone's own copy of the task list, synced straight with the
// Control Plane account's cloud task store, so Tasks work while the Mac
// sleeps. Same engine as the Mac (packages/shared/src/taskSync). Links,
// proposals and hand-offs stay Mac-only: they arrive through the paired Mac.

const TOKEN_KEY = "cplane-task-sync-device-token";
const SYNC_INTERVAL_MS = 60_000;
const EDIT_DEBOUNCE_MS = 1_000;

export interface CloudTaskSnapshot {
  readonly tasks: ReadonlyArray<Task>;
  readonly intents: ReadonlyArray<TaskIntent>;
  readonly status: TaskSyncStatus | null;
}

function readConfig(): TaskSyncConfig | null {
  const extra = Constants.expoConfig?.extra?.taskSync as
    | { url?: unknown; keyId?: unknown; secret?: unknown }
    | undefined;
  const keyId = typeof extra?.keyId === "string" ? extra.keyId.trim() : "";
  const secret = typeof extra?.secret === "string" ? extra.secret.trim() : "";
  const url = typeof extra?.url === "string" && extra.url.trim() ? extra.url.trim() : "";
  if (keyId.length === 0 || !/^[0-9a-f]{64}$/i.test(secret)) return null;
  return { baseUrl: (url || "https://mcp.lucive.app").replace(/\/+$/, ""), keyId, secret };
}

function dataDir(): InstanceType<typeof Directory> {
  return new Directory(Paths.document, "task-sync");
}

function readJson<T>(name: string): T | null {
  try {
    const file = new File(dataDir(), name);
    return file.exists ? (JSON.parse(file.textSync()) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(name: string, value: unknown): void {
  try {
    const dir = dataDir();
    if (!dir.exists) dir.create({ intermediates: true });
    new File(dir, name).write(JSON.stringify(value));
  } catch {
    // Device-local cache; the next sync rewrites it.
  }
}

const intentKey = (intent: Pick<TaskIntent, "horizon" | "startsOn">) =>
  `${intent.horizon}:${intent.startsOn}`;

/** User copy for a failed cloud call, without naming the backing service. */
export function cloudErrorMessage(error: unknown): string {
  return error instanceof TaskSyncCloudError
    ? new TaskSyncError({ reason: error.reason }).message
    : "Something went wrong. Try again.";
}

class CloudTaskStore {
  private snapshot: CloudTaskSnapshot = { tasks: [], intents: [], status: null };
  private readonly listeners = new Set<() => void>();
  private readonly engine: TaskSyncEngine;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor() {
    const config = readConfig();
    const cached = readJson<{ tasks: Task[]; intents: TaskIntent[] }>("tasks.json");
    if (cached !== null) {
      this.snapshot = { tasks: cached.tasks, intents: cached.intents, status: null };
    }
    this.engine = new TaskSyncEngine({
      client:
        config === null
          ? null
          : makeTaskSyncCloudClient(config, (input, init) => fetch(input, init), Date.now, {
              platform: "ios",
              returnTo: "mobile",
              randomBytes: (length) => ExpoCrypto.getRandomBytes(length),
            }),
      loadState: async () => readJson<TaskSyncPersistedState>("state.json") ?? emptyTaskSyncState(),
      saveState: async (state) => writeJson("state.json", state),
      getToken: () => SecureStore.getItemAsync(TOKEN_KEY),
      setToken: async (token) => {
        if (token === null) await SecureStore.deleteItemAsync(TOKEN_KEY);
        else await SecureStore.setItemAsync(TOKEN_KEY, token);
      },
      apply: async (changes) => this.applyChanges(changes),
      readLocal: async () => ({ tasks: this.snapshot.tasks, intents: this.snapshot.intents }),
      deviceName:
        Platform.OS === "ios" && Platform.isPad
          ? "Control Plane on iPad"
          : "Control Plane on iPhone",
      now: () => new Date(),
      newId: () => uuidv4(),
    });
  }

  getSnapshot = (): CloudTaskSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(next: Partial<CloudTaskSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    if (next.tasks !== undefined || next.intents !== undefined) {
      writeJson("tasks.json", { tasks: this.snapshot.tasks, intents: this.snapshot.intents });
    }
    for (const listener of this.listeners) listener();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    void this.syncNow();
    this.interval = setInterval(() => {
      if (AppState.currentState === "active") void this.syncNow();
    }, SYNC_INTERVAL_MS);
    AppState.addEventListener("change", (state) => {
      if (state === "active") void this.syncNow();
    });
  }

  private async refreshStatus(): Promise<TaskSyncStatus> {
    const status = await this.engine.status();
    this.emit({ status });
    return status;
  }

  private applyChanges(changes: TaskSyncApply): void {
    const removed = new Set(changes.removedTaskIds);
    const byId = new Map(this.snapshot.tasks.map((task) => [task.id as string, task]));
    for (const id of removed) byId.delete(id);
    for (const task of changes.tasks) byId.set(task.id, task);
    const intents = new Map(this.snapshot.intents.map((intent) => [intentKey(intent), intent]));
    for (const gone of changes.removedIntents) intents.delete(intentKey(gone));
    for (const intent of changes.intents) intents.set(intentKey(intent), intent);
    this.emit({ tasks: [...byId.values()], intents: [...intents.values()] });
  }

  async syncNow(): Promise<TaskSyncStatus> {
    await this.engine.sync();
    return this.refreshStatus();
  }

  private scheduleSync(): void {
    if (this.editTimer !== null) clearTimeout(this.editTimer);
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      void this.syncNow();
    }, EDIT_DEBOUNCE_MS);
  }

  async requestCode(email: string): Promise<void> {
    await this.engine.requestCode(email);
  }

  async verify(email: string, code: string): Promise<TaskSyncStatus> {
    // The account's list replaces whatever this phone cached before.
    this.emit({ tasks: [], intents: [] });
    await this.engine.verify(email, code);
    return this.refreshStatus();
  }

  async signOut(): Promise<TaskSyncStatus> {
    await this.engine.signOut();
    this.emit({ tasks: [], intents: [] });
    return this.refreshStatus();
  }

  checkoutUrl(): Promise<string> {
    return this.engine.checkoutUrl();
  }

  portalUrl(): Promise<string> {
    return this.engine.portalUrl();
  }

  private async write(tasks: ReadonlyArray<Task>): Promise<void> {
    const byId = new Map(this.snapshot.tasks.map((task) => [task.id as string, task]));
    for (const task of tasks) byId.set(task.id, task);
    this.emit({ tasks: [...byId.values()] });
    for (const task of tasks) await this.engine.onLocalTask(task.id, task);
    this.scheduleSync();
  }

  async create(input: LocalTaskInput): Promise<void> {
    await this.write([createLocalTask(input, new Date().toISOString())]);
  }

  async patch(taskId: TaskId, patch: TaskPatch): Promise<boolean> {
    const stored = this.snapshot.tasks.find((task) => task.id === taskId);
    if (stored === undefined) return false;
    await this.write(
      patchLocalTask(stored, patch, new Date().toISOString(), () => uuidv4() as TaskId),
    );
    return true;
  }

  async delete(taskId: TaskId): Promise<void> {
    this.emit({ tasks: this.snapshot.tasks.filter((task) => task.id !== taskId) });
    await this.engine.onLocalTask(taskId, null);
    this.scheduleSync();
  }

  async setIntent(horizon: TaskHorizon, startsOn: string, text: string): Promise<void> {
    const key = `${horizon}:${startsOn}`;
    const others = this.snapshot.intents.filter((intent) => intentKey(intent) !== key);
    const existing = this.snapshot.intents.find((intent) => intentKey(intent) === key);
    const trimmed = text.trim();
    const intents =
      trimmed.length === 0 || existing === undefined
        ? trimmed.length === 0
          ? others
          : [
              ...others,
              {
                horizon,
                startsOn,
                text: trimmed,
                updatedAt: new Date().toISOString(),
              } as TaskIntent,
            ]
        : [...others, { ...existing, text: trimmed, updatedAt: new Date().toISOString() }];
    this.emit({ intents });
    await this.engine.onLocalIntent(horizon, startsOn, trimmed.length === 0 ? null : trimmed);
    this.scheduleSync();
  }
}

let store: CloudTaskStore | null = null;

export function cloudTaskStore(): CloudTaskStore {
  store ??= new CloudTaskStore();
  return store;
}

export type { CloudTaskStore };
