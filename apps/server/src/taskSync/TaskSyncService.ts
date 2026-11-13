// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - the sync engine is promise-based plain TypeScript; this adapter feeds it wall-clock time, a debounce timer and an atomic JSON state file.
/**
 * Task Sync on the server: wires the sync engine to the event store, the
 * secret store and a small state file, syncs on a timer and after local
 * edits, and answers the `taskSync.*` RPCs. Fork-owned.
 */
import {
  CommandId,
  TaskId,
  TaskSyncError,
  setTaskWeekStartsOn,
  type OrchestrationEvent,
  type TaskSyncStatus,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { makeTaskSyncCloudClient, TaskSyncCloudError } from "@t3tools/shared/taskSync/cloudClient";
import { readTaskSyncConfig } from "./config.ts";
import {
  emptyTaskSyncState,
  TaskSyncEngine,
  type TaskSyncPersistedState,
} from "@t3tools/shared/taskSync/engine";

const TOKEN_SECRET = "task-sync-device-token";
const SYNC_COMMAND_PREFIX = "task-sync:";
const SYNC_INTERVAL = "60 seconds";
const LOCAL_EDIT_DEBOUNCE_MS = 1500;

export class TaskSyncService extends Context.Service<
  TaskSyncService,
  {
    readonly status: Effect.Effect<TaskSyncStatus, TaskSyncError>;
    readonly requestCode: (email: string) => Effect.Effect<void, TaskSyncError>;
    readonly verify: (email: string, code: string) => Effect.Effect<TaskSyncStatus, TaskSyncError>;
    readonly signOut: Effect.Effect<TaskSyncStatus, TaskSyncError>;
    readonly checkoutUrl: Effect.Effect<{ url: string }, TaskSyncError>;
    readonly portalUrl: Effect.Effect<{ url: string }, TaskSyncError>;
    readonly syncNow: Effect.Effect<TaskSyncStatus, TaskSyncError>;
  }
>()("t3/taskSync/TaskSyncService") {}

function toTaskSyncError(error: unknown): TaskSyncError {
  if (error instanceof TaskSyncCloudError) return new TaskSyncError({ reason: error.reason });
  return new TaskSyncError({ reason: "server" });
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const orchestration = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const hostPlatform = yield* HostProcessPlatform;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);

  const statePath = NodePath.join(config.stateDir, "task-sync", "state.json");
  const syncConfig = readTaskSyncConfig();
  const client =
    syncConfig === null
      ? null
      : makeTaskSyncCloudClient(syncConfig, undefined, undefined, {
          platform:
            hostPlatform === "win32" ? "windows" : hostPlatform === "linux" ? "linux" : "macos",
          returnTo: "desktop",
        });

  const engine = new TaskSyncEngine({
    client,
    deviceName: `Control Plane on ${NodeOS.hostname().replace(/\.local$/, "")}`.slice(0, 80),
    now: () => new Date(Date.now()),
    newId: () => NodeCrypto.randomUUID(),
    onWeekStart: setTaskWeekStartsOn,
    log: (message, detail) =>
      void runPromise(Effect.logWarning(message, { detail: String(detail) })),
    loadState: async () => {
      try {
        const parsed = JSON.parse(
          await NodeFSP.readFile(statePath, "utf8"),
        ) as TaskSyncPersistedState;
        return parsed.version === 1 ? parsed : emptyTaskSyncState();
      } catch {
        return emptyTaskSyncState();
      }
    },
    saveState: async (state) => {
      await NodeFSP.mkdir(NodePath.dirname(statePath), { recursive: true, mode: 0o700 });
      const temporary = `${statePath}.${process.pid}.tmp`;
      await NodeFSP.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await NodeFSP.rename(temporary, statePath);
    },
    getToken: () =>
      runPromise(
        secrets.get(TOKEN_SECRET).pipe(
          Effect.map((value) =>
            Option.isSome(value) ? new TextDecoder().decode(value.value) : null,
          ),
          Effect.orElseSucceed(() => null),
        ),
      ),
    setToken: (token) =>
      runPromise(
        token === null
          ? secrets.remove(TOKEN_SECRET).pipe(Effect.ignore)
          : secrets.set(TOKEN_SECRET, new TextEncoder().encode(token)).pipe(Effect.orDie),
      ),
    readLocal: () =>
      runPromise(
        snapshots.getCommandReadModel().pipe(
          Effect.map((model) => ({ tasks: model.tasks ?? [], intents: model.taskIntents ?? [] })),
          Effect.orDie,
        ),
      ),
    apply: (changes) =>
      runPromise(
        orchestration
          .dispatch({
            type: "task.sync.apply",
            commandId: CommandId.make(`${SYNC_COMMAND_PREFIX}${NodeCrypto.randomUUID()}`),
            tasks: changes.tasks,
            removedTaskIds: changes.removedTaskIds.map((id) => TaskId.make(id)),
            intents: changes.intents,
            removedIntents: changes.removedIntents,
            createdAt: new Date(Date.now()).toISOString(),
          })
          // "Nothing changed" is the quiet case.
          .pipe(Effect.ignore),
      ),
  });

  let debounce: ReturnType<typeof setTimeout> | null = null;
  const scheduleSync = () => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void engine.sync();
    }, LOCAL_EDIT_DEBOUNCE_MS);
  };

  const onEvent = (event: OrchestrationEvent) =>
    Effect.promise(async () => {
      if (event.commandId?.startsWith(SYNC_COMMAND_PREFIX) === true) return;
      if (event.type === "task.updated") {
        await engine.onLocalTask(event.payload.taskId, event.payload.task);
        scheduleSync();
      } else if (event.type === "task.intent-updated") {
        await engine.onLocalIntent(
          event.payload.horizon,
          event.payload.startsOn,
          event.payload.intent?.text ?? null,
        );
        scheduleSync();
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("task sync could not queue a local edit", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

  if (client !== null) {
    const events = yield* orchestration.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, onEvent));
    yield* forkParked(
      Effect.promise(() => engine.sync()).pipe(
        Effect.repeat(Schedule.spaced(SYNC_INTERVAL)),
        Effect.asVoid,
      ),
    );
  }

  const attempt = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: toTaskSyncError });

  return {
    status: attempt(() => engine.status()),
    requestCode: (email) => attempt(() => engine.requestCode(email)),
    verify: (email, code) => attempt(() => engine.verify(email, code)),
    signOut: attempt(() => engine.signOut()),
    checkoutUrl: attempt(async () => ({ url: await engine.checkoutUrl() })),
    portalUrl: attempt(async () => ({ url: await engine.portalUrl() })),
    syncNow: attempt(async () => {
      await engine.refreshSubscription().catch(() => undefined);
      await engine.sync();
      return engine.status();
    }),
  } satisfies TaskSyncService["Service"];
});

export const layer = Layer.effect(TaskSyncService, make).pipe(
  Layer.provide(ServerSecretStore.layer),
);

const unavailable = Effect.fail(new TaskSyncError({ reason: "unavailable" }));

/** Task Sync switched off (tests, and builds without a client key). */
export const layerUnavailable = Layer.succeed(TaskSyncService, {
  status: Effect.succeed({ state: "unavailable" as const, pendingChanges: 0, weekStartsOn: 1 }),
  requestCode: () => unavailable,
  verify: () => unavailable,
  signOut: unavailable,
  checkoutUrl: unavailable,
  portalUrl: unavailable,
  syncNow: unavailable,
});
