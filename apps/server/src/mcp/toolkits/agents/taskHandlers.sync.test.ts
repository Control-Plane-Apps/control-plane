// @effect-diagnostics globalDate:off - the sync engine under test takes a plain clock.
/**
 * The Assistant's task tools against a Lucive-synced account: a real Task
 * Sync engine over an in-memory cloud with the real store's rules
 * (last-writer-wins by updatedAt, tombstones, a seq feed). Local edits reach
 * the engine the way TaskSyncService feeds them: every `task.updated` /
 * `task.intent-updated` event not written by sync itself.
 */
import { RemoteAgentsLocalOnly } from "../../../agentMachines/testFixtures.ts";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  TaskId,
  ThreadId,
  type Task,
} from "@t3tools/contracts";
import type {
  ChangesPage,
  PushBatch,
  TaskSyncCloudClient,
  WireMembershipFull,
  WirePeriodFull,
  WireTaskWithSeq,
} from "@t3tools/shared/taskSync/cloudClient";
import { emptyTaskSyncState, TaskSyncEngine } from "@t3tools/shared/taskSync/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../../../config.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { makeProviderRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { TaskSyncService } from "../../../taskSync/TaskSyncService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AgentsToolkitHandlersLive } from "./handlers.ts";
import {
  AgentsToolkit,
  TaskDeleteResult,
  TaskIntentSetResult,
  TaskListResult,
  TaskReorderResult,
  TaskRestoreResult,
  TaskUpdateResult,
  type TaskDeleteInput,
  type TaskIntentSetInput,
  type TaskListInput,
  type TaskReorderInput,
  type TaskRestoreInput,
  type TaskUpdateInput,
} from "./tools.ts";

const T0 = "2026-11-01T12:00:00.000Z";
const NOW = "2026-11-13T17:00:00.000Z";
const CODEX = ProviderInstanceId.make("codex");
const HOME = ProjectId.make("assistant-home");
const ASSISTANT = ThreadId.make("assistant");
const SYNC_PREFIX = "task-sync:";

/** The cloud store's rules: LWW by updatedAt, tombstones kept, a seq feed. */
class FakeCloud implements TaskSyncCloudClient {
  seq = 0;
  tasks = new Map<string, WireTaskWithSeq & { seq: number }>();
  periods = new Map<string, WirePeriodFull & { seq: number }>();
  memberships = new Map<string, WireMembershipFull & { seq: number }>();

  seedTask(task: Partial<WireTaskWithSeq> & { id: string }) {
    this.seq += 1;
    this.tasks.set(task.id, {
      title: task.id,
      notes: null,
      status: "todo",
      scheduledDate: null,
      reminderTime: null,
      backlogHorizon: null,
      completedAt: null,
      sortOrder: 0,
      isTemplate: false,
      templateId: null,
      recurrence: null,
      createdAt: T0,
      updatedAt: T0,
      deletedAt: null,
      ...task,
      seq: this.seq,
    });
  }

  availability = async () => true;
  requestCode = async () => undefined;
  verify = async ({ email }: { email: string }) => ({ token: "device-token", email });
  revoke = async () => undefined;
  subscription = async () => ({ status: "active" as const });
  checkout = async () => "https://checkout.example/session";
  portal = async () => "https://portal.example/session";

  changes = async (_token: string, since: number): Promise<ChangesPage> => {
    const after = <T extends { seq: number }>(rows: Iterable<T>) =>
      [...rows].filter((row) => row.seq > since);
    return {
      tasks: after(this.tasks.values()),
      periods: after(this.periods.values()),
      memberships: after(this.memberships.values()),
      nextSince: this.seq,
      hasMore: false,
      settings: { weekStartsOn: 1 },
    };
  };

  push = async (_token: string, batch: PushBatch) => {
    for (const raw of batch.periods) {
      const period = raw as unknown as WirePeriodFull;
      this.seq += 1;
      this.periods.set(period.id, { ...period, seq: this.seq });
    }
    for (const raw of batch.tasks) {
      const task = raw as unknown as WireTaskWithSeq;
      const stored = this.tasks.get(task.id);
      if (stored !== undefined && stored.updatedAt >= task.updatedAt) continue;
      this.seq += 1;
      this.tasks.set(task.id, { ...task, seq: this.seq });
    }
    for (const raw of batch.memberships) {
      const membership = raw as unknown as WireMembershipFull;
      this.seq += 1;
      this.memberships.set(membership.id, { ...membership, seq: this.seq });
    }
    return {};
  };
}

let engine: TaskSyncEngine | null = null;

const TestLayer = AgentsToolkitHandlersLive.pipe(
  Layer.provideMerge(makeProviderRegistryLayer()),
  Layer.provideMerge(RemoteAgentsLocalOnly),
  Layer.provideMerge(
    Layer.mock(ServerSettingsService)({
      getSettings: Effect.sync(() => ({
        ...DEFAULT_SERVER_SETTINGS,
        assistant: { ...DEFAULT_SERVER_SETTINGS.assistant, tasks: "edit" as const },
      })),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(TaskSyncService)({
      syncedTaskIds: Effect.promise(() =>
        engine === null ? Promise.resolve(new Set<string>()) : engine.syncedTaskIds(),
      ),
    }),
  ),
  Layer.provideMerge(
    OrchestrationEngineLive.pipe(
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-task-sync-tools-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

let counter = 0;
const cid = () => CommandId.make(`sync-test-${(counter += 1)}`);
const dispatch = (command: Parameters<OrchestrationEngineService["Service"]["dispatch"]>[0]) =>
  Effect.flatMap(OrchestrationEngineService, (orchestration) => orchestration.dispatch(command));

const seedAssistant = Effect.gen(function* () {
  yield* dispatch({
    type: "project.create",
    commandId: cid(),
    projectId: HOME,
    title: "Assistant",
    workspaceRoot: "/tmp/assistant-home",
    createdAt: T0,
  });
  yield* dispatch({
    type: "thread.create",
    commandId: cid(),
    threadId: ASSISTANT,
    projectId: HOME,
    title: "Today",
    modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: T0,
  });
  yield* dispatch({
    type: "project.meta.update",
    commandId: cid(),
    projectId: HOME,
    assistant: { coordinatorThreadId: ASSISTANT, scope: "global" },
  });
});

/** Wires a sync engine to this test's event store and read model, signed in. */
const connect = (cloud: FakeCloud) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      OrchestrationEngineService | ProjectionSnapshotQuery | OrchestrationEventStore
    >();
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- the sync engine is promise-based; this is the same bridge TaskSyncService uses in production.
    const runPromise = Effect.runPromiseWith(context);
    let state = emptyTaskSyncState();
    let token: string | null = null;
    let clock = Date.parse(NOW);
    let ids = 0;
    const created = new TaskSyncEngine({
      client: cloud,
      loadState: async () => state,
      saveState: async (next) => {
        state = next;
      },
      getToken: async () => token,
      setToken: async (next) => {
        token = next;
      },
      readLocal: () =>
        runPromise(
          Effect.flatMap(ProjectionSnapshotQuery, (query) => query.getCommandReadModel()).pipe(
            Effect.map((model) => ({ tasks: model.tasks ?? [], intents: model.taskIntents ?? [] })),
            Effect.orDie,
          ),
        ),
      apply: (changes) =>
        runPromise(
          dispatch({
            type: "task.sync.apply",
            commandId: CommandId.make(`${SYNC_PREFIX}${(ids += 1)}`),
            tasks: changes.tasks,
            removedTaskIds: changes.removedTaskIds.map((id) => TaskId.make(id)),
            intents: changes.intents,
            removedIntents: changes.removedIntents,
            createdAt: new Date(clock).toISOString(),
          }).pipe(Effect.ignore),
        ),
      deviceName: "Test Mac",
      now: () => new Date((clock += 1000)),
      newId: () => `gen-${(ids += 1)}`,
    });
    engine = created;
    yield* Effect.promise(() => created.verify("n@example.com", "123456"));
    let cursor = 0;
    /** Feeds new local edits to the engine like TaskSyncService, then syncs. */
    const pump = Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      const events = yield* Stream.runCollect(store.readFromSequence(cursor));
      for (const event of events) {
        cursor = Math.max(cursor, event.sequence);
        if (event.commandId?.startsWith(SYNC_PREFIX) === true) continue;
        if (event.type === "task.updated") {
          yield* Effect.promise(() =>
            created.onLocalTask(event.payload.taskId, event.payload.task),
          );
        } else if (event.type === "task.intent-updated") {
          yield* Effect.promise(() =>
            created.onLocalIntent(
              event.payload.horizon,
              event.payload.startsOn,
              event.payload.intent?.text ?? null,
            ),
          );
        }
      }
      yield* Effect.promise(() => created.sync());
    });
    yield* pump;
    return pump;
  });

const call = <S extends Schema.ConstraintDecoder<unknown>, E, R>(
  handled: Effect.Effect<Stream.Stream<{ readonly result: unknown }, E, R>, E, R>,
  success: S,
) =>
  handled.pipe(
    Stream.unwrap,
    Stream.runCollect,
    Effect.map((chunk) => Schema.decodeUnknownSync(success)(chunk.at(-1)!.result)),
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ASSISTANT,
      providerSessionId: "provider-session-1",
      providerInstanceId: CODEX,
      capabilities: new Set<McpInvocationContext.McpCapability>(["agents"]),
      issuedAt: 1,
    }),
  );

const tools = {
  list: (params: TaskListInput) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_list", params), TaskListResult),
    ),
  update: (params: TaskUpdateInput) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_update", params), TaskUpdateResult),
    ),
  delete: (params: TaskDeleteInput) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_delete", params), TaskDeleteResult),
    ),
  restore: (params: TaskRestoreInput) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_restore", params), TaskRestoreResult),
    ),
  reorder: (params: TaskReorderInput) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_reorder", params), TaskReorderResult),
    ),
  intent: (params: TaskIntentSetInput) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_intent_set", params), TaskIntentSetResult),
    ),
};
const id = (value: string) => TaskId.make(value);

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.setTime(Date.parse(NOW)).pipe(
    Effect.andThen(seedAssistant),
    Effect.andThen(effect),
    Effect.ensuring(Effect.sync(() => (engine = null))),
    Effect.provide(TestLayer),
  );

describe("Assistant task tools on a Lucive-synced account", () => {
  it.effect("cancel, delete, restore and reorder round-trip through the synced store", () =>
    run(
      Effect.gen(function* () {
        const cloud = new FakeCloud();
        cloud.seedTask({
          id: "lift",
          title: "Gym lift, 45 min",
          scheduledDate: "2026-11-14",
          sortOrder: 1,
        });
        cloud.seedTask({ id: "run", title: "Run", scheduledDate: "2026-11-14", sortOrder: 2 });
        cloud.seedTask({ id: "swim", title: "Swim", scheduledDate: "2026-11-14", sortOrder: 3 });
        const pump = yield* connect(cloud);

        const listed = yield* tools.list({ range: "this-week", text: "lift" });
        expect(listed.tasks.map((task) => [task.id, task.synced])).toEqual([["lift", true]]);

        // Cancel: same record, status cancelled on the account.
        yield* tools.update({ taskId: id("lift"), status: "cancelled" });
        yield* pump;
        expect(cloud.tasks.get("lift")).toMatchObject({ status: "cancelled", deletedAt: null });

        // Restore from cancelled: open again everywhere.
        yield* tools.restore({ taskId: id("lift") });
        yield* pump;
        expect(cloud.tasks.get("lift")).toMatchObject({ status: "todo", completedAt: null });

        // Delete: a tombstone on the account, never a hard delete.
        const deleted = yield* tools.delete({ taskId: id("lift") });
        expect(deleted.synced).toBe(true);
        yield* pump;
        expect(cloud.tasks.get("lift")?.deletedAt).not.toBeNull();
        expect(cloud.tasks.has("lift")).toBe(true);
        // A later pull leaves it deleted here too.
        yield* pump;
        const afterPull = yield* tools.list({ status: "any" });
        expect(afterPull.tasks.map((task) => task.id)).not.toContain("lift");

        // Restore: the same id comes back and the tombstone is lifted.
        const restored = yield* tools.restore({ taskId: id("lift") });
        expect(restored.task).toMatchObject({
          id: "lift",
          title: "Gym lift, 45 min",
          importSource: { kind: "lucive", id: "lift" },
        });
        yield* pump;
        expect(cloud.tasks.get("lift")).toMatchObject({
          deletedAt: null,
          scheduledDate: "2026-11-14",
          title: "Gym lift, 45 min",
        });

        // Reorder: the account's sortOrder follows the new order.
        yield* tools.reorder({ taskId: id("swim"), beforeTaskId: id("lift") });
        yield* pump;
        const sort = (id: string) => cloud.tasks.get(id)!.sortOrder;
        expect(sort("swim")).toBeLessThan(sort("lift"));
        expect(sort("lift")).toBeLessThan(sort("run"));
      }),
    ),
  );

  it.effect("repeating series: skip an occurrence, stop the series, and set intents", () =>
    run(
      Effect.gen(function* () {
        const cloud = new FakeCloud();
        cloud.seedTask({
          id: "tpl",
          title: "Gym lift",
          isTemplate: true,
          scheduledDate: "2026-11-07",
          recurrence: { frequency: "weekly", interval: 1 },
        });
        cloud.seedTask({
          id: "occ-14",
          title: "Gym lift",
          scheduledDate: "2026-11-14",
          templateId: "tpl",
          recurrence: { frequency: "weekly", interval: 1 },
        });
        const pump = yield* connect(cloud);

        const series = yield* tools.list({ repeating: true });
        expect(series.tasks.map((task) => [task.id, task.seriesId])).toEqual([["occ-14", "tpl"]]);

        // Skip this week's occurrence: tombstoned, the next joins the same series.
        const skipped = yield* tools.delete({ taskId: id("occ-14") });
        expect(skipped.next?.home).toEqual({ kind: "date", date: "2026-11-21" });
        yield* pump;
        expect(cloud.tasks.get("occ-14")?.deletedAt).not.toBeNull();
        const next = cloud.tasks.get(skipped.next!.id)!;
        expect(next).toMatchObject({
          scheduledDate: "2026-11-21",
          templateId: "tpl",
          deletedAt: null,
        });
        expect(cloud.tasks.get("tpl")?.deletedAt).toBeNull();

        // Stop the series: the template is retired, the pending occurrence deleted.
        yield* tools.delete({ taskId: skipped.next!.id, scope: "series" });
        yield* pump;
        expect(cloud.tasks.get("tpl")?.deletedAt).not.toBeNull();
        expect(cloud.tasks.get(skipped.next!.id)?.deletedAt).not.toBeNull();

        // Intents become the period's focus line on the account.
        yield* tools.intent({ horizon: "week", when: "this", text: "Rest the knee" });
        yield* pump;
        const week = [...cloud.periods.values()].find(
          (period) => period.horizon === "week" && period.startsOn === "2026-11-09",
        );
        expect(week?.focus).toBe("Rest the knee");
      }),
    ),
  );
});

export type { Task };
