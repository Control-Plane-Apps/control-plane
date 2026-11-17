import { RemoteAgentsLocalOnly } from "../../../agentMachines/testFixtures.ts";
import {
  CommandId,
  compareTaskOrder,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  getTaskWeekStartsOn,
  ProviderInstanceId,
  setTaskWeekStartsOn,
  taskPeriodFor,
  TaskId,
  taskHandoffDeliveryId,
  ThreadId,
  type AssistantSettings,
  type OrchestrationCommand,
  type Task,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
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
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { makeProviderRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AgentsToolkitHandlersLive } from "./handlers.ts";
import {
  planTaskReorder,
  resolveTaskHome,
  taskHomeOf,
  taskListWindow,
  withReminder,
} from "./taskHandlers.ts";
import {
  AgentsToolkit,
  TaskBulkResult,
  TaskDeleteResult,
  TaskIntentSetResult,
  TaskListResult,
  TaskProposeResult,
  TaskReorderResult,
  TaskRestoreResult,
  TaskUpdateResult,
  type TaskBulkInput,
  type TaskDeleteInput,
  type TaskHandoffInput,
  type TaskProposalRespondInput,
  type TaskIntentSetInput,
  type TaskListInput,
  type TaskProposeInput,
  type TaskReorderInput,
  type TaskRestoreInput,
  type TaskUpdateInput,
} from "./tools.ts";

describe("taskHomeOf", () => {
  it("maps every `when` to a task home from the local today", () => {
    // 2026-11-13 is a Friday; weeks start on Monday by default.
    const today = "2026-11-13";
    expect(taskHomeOf("today", today)).toEqual({ kind: "date", date: "2026-11-13" });
    expect(taskHomeOf("tomorrow", today)).toEqual({ kind: "date", date: "2026-11-14" });
    const week = { kind: "period", horizon: "week" } as const;
    expect(taskHomeOf(undefined, today)).toEqual({
      ...week,
      startsOn: "2026-11-09",
      endsOn: "2026-11-15",
    });
    expect(taskHomeOf("this-week", today)).toEqual(taskHomeOf(undefined, today));
    expect(taskHomeOf("next-week", today)).toEqual({
      ...week,
      startsOn: "2026-11-16",
      endsOn: "2026-11-22",
    });
    expect(taskHomeOf("this-month", today)).toEqual({
      kind: "period",
      horizon: "month",
      startsOn: "2026-11-01",
      endsOn: "2026-11-30",
    });
    expect(taskHomeOf("next-month", "2026-12-31")).toEqual({
      kind: "period",
      horizon: "month",
      startsOn: "2027-01-01",
      endsOn: "2027-01-31",
    });
    expect(taskHomeOf("this-year", today)).toEqual({
      kind: "period",
      horizon: "year",
      startsOn: "2026-01-01",
      endsOn: "2026-12-31",
    });
    expect(taskHomeOf("next-year", today)).toEqual({
      kind: "period",
      horizon: "year",
      startsOn: "2027-01-01",
      endsOn: "2027-12-31",
    });
    expect(taskHomeOf("backlog", today)).toEqual({ kind: "backlog", horizon: null });
    expect(taskHomeOf("week-backlog", today)).toEqual({ kind: "backlog", horizon: "week" });
    expect(taskHomeOf("month-backlog", today)).toEqual({ kind: "backlog", horizon: "month" });
    expect(taskHomeOf("year-backlog", today)).toEqual({ kind: "backlog", horizon: "year" });
  });
});

describe("resolveTaskHome", () => {
  const today = "2026-11-13";

  it("puts a date on that day, or commits to the period containing it", () => {
    expect(resolveTaskHome({ date: "2026-11-16" }, today)).toEqual({
      kind: "date",
      date: "2026-11-16",
    });
    expect(resolveTaskHome({ date: "2026-11-18", period: "week" }, today)).toEqual({
      kind: "period",
      horizon: "week",
      startsOn: "2026-11-16",
      endsOn: "2026-11-22",
    });
    expect(resolveTaskHome({ date: "2027-02-10", period: "month" }, today)).toEqual({
      kind: "period",
      horizon: "month",
      startsOn: "2027-02-01",
      endsOn: "2027-02-28",
    });
    expect(resolveTaskHome({ date: "2028-06-01", period: "year" }, today)).toEqual({
      kind: "period",
      horizon: "year",
      startsOn: "2028-01-01",
      endsOn: "2028-12-31",
    });
    expect(resolveTaskHome({ when: "next-week" }, today)).toEqual(taskHomeOf("next-week", today));
    expect(resolveTaskHome({}, today)).toBeNull();
  });

  it("refuses unreal dates and contradictory fields", () => {
    expect(resolveTaskHome({ date: "2026-02-30" }, today)).toMatch(/not a real date/);
    expect(resolveTaskHome({ date: "2026-13-01" }, today)).toMatch(/not a real date/);
    expect(resolveTaskHome({ date: "Monday" }, today)).toMatch(/YYYY-MM-DD/);
    expect(resolveTaskHome({ date: "2026-11-16", when: "today" }, today)).toMatch(/not both/);
    expect(resolveTaskHome({ period: "week" }, today)).toMatch(/needs a `date`/);
  });
});

describe("withReminder", () => {
  it("sets, keeps and clears a day's reminder, and only on a day", () => {
    const day = { kind: "date", date: "2026-11-16" } as const;
    expect(withReminder(day, "09:30")).toEqual({ ...day, reminderTime: "09:30" });
    expect(withReminder({ ...day, reminderTime: "09:30" }, undefined)).toEqual({
      ...day,
      reminderTime: "09:30",
    });
    expect(withReminder({ ...day, reminderTime: "09:30" }, null)).toEqual(day);
    expect(withReminder(day, "9:30")).toMatch(/not a time/);
    expect(withReminder(day, "24:00")).toMatch(/not a time/);
    expect(withReminder({ kind: "backlog", horizon: null }, "09:30")).toMatch(/single day/);
  });
});

// ── The tools against the real engine ──────────────────────────────

const CODEX = ProviderInstanceId.make("codex");
const SEEDED_AT = "2026-11-01T00:00:00.000Z";
/** Friday 2026-11-13, midday UTC, so the local day is the 13th in every US zone. */
const NOW = "2026-11-13T17:00:00.000Z";
const ACME = ProjectId.make("acme");
const OTHER = ProjectId.make("other");
const HOME = ProjectId.make("assistant-home");
const ACME_COORD = ThreadId.make("acme-coord");
const ACME_STANDING = ThreadId.make("acme-standing");
const OTHER_COORD = ThreadId.make("other-coord");
const ASSISTANT = ThreadId.make("assistant");
const ASSISTANT_CHANNEL = ThreadId.make("assistant-channel");

let settings = DEFAULT_SERVER_SETTINGS;
const useAssistant = (patch: Partial<AssistantSettings>) => {
  settings = {
    ...DEFAULT_SERVER_SETTINGS,
    assistant: { ...DEFAULT_SERVER_SETTINGS.assistant, ...patch },
  };
};

const TestLayer = AgentsToolkitHandlersLive.pipe(
  Layer.provideMerge(makeProviderRegistryLayer()),
  Layer.provideMerge(RemoteAgentsLocalOnly),
  Layer.provideMerge(
    Layer.mock(ServerSettingsService)({ getSettings: Effect.sync(() => settings) }),
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
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-task-tools-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

let counter = 0;
const cid = () => CommandId.make(`task-test-${(counter += 1)}`);
const dispatch = (command: OrchestrationCommand) =>
  Effect.flatMap(OrchestrationEngineService, (engine) => engine.dispatch(command));

const createThread = (threadId: ThreadId, projectId: ProjectId) =>
  dispatch({
    type: "thread.create",
    commandId: cid(),
    threadId,
    projectId,
    title: threadId,
    modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: SEEDED_AT,
  });

/** Acme (coordinator + a pinned standing agent), Other, and the global Assistant with a pinned channel. */
const seed = Effect.gen(function* () {
  for (const [projectId, coordinator, scope] of [
    [ACME, ACME_COORD, undefined],
    [OTHER, OTHER_COORD, undefined],
    [HOME, ASSISTANT, "global"],
  ] as const) {
    yield* dispatch({
      type: "project.create",
      commandId: cid(),
      projectId,
      title: projectId,
      workspaceRoot: `/tmp/${projectId}`,
      createdAt: SEEDED_AT,
    });
    yield* createThread(coordinator, projectId);
    yield* dispatch({
      type: "project.meta.update",
      commandId: cid(),
      projectId,
      assistant: { coordinatorThreadId: coordinator, ...(scope ? { scope } : {}) },
    });
  }
  yield* createThread(ACME_STANDING, ACME);
  yield* dispatch({ type: "thread.pin", commandId: cid(), threadId: ACME_STANDING });
  yield* createThread(ASSISTANT_CHANNEL, HOME);
  yield* dispatch({ type: "thread.pin", commandId: cid(), threadId: ASSISTANT_CHANNEL });
  // One task the user added themselves.
  yield* dispatch({
    type: "task.create",
    commandId: cid(),
    taskId: TaskId.make("user-task"),
    title: "Renew passport",
    home: { kind: "backlog", horizon: null },
    createdAt: SEEDED_AT,
  });
});

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.setTime(Date.parse(NOW)).pipe(
    Effect.andThen(seed),
    Effect.andThen(effect),
    Effect.provide(TestLayer),
  );

const call = <S extends Schema.ConstraintDecoder<unknown>, E, R>(
  handled: Effect.Effect<Stream.Stream<{ readonly result: unknown }, E, R>, E, R>,
  success: S,
  caller: ThreadId,
) =>
  handled.pipe(
    Stream.unwrap,
    Stream.runCollect,
    Effect.map((chunk) => Schema.decodeUnknownSync(success)(chunk.at(-1)!.result)),
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: caller,
      providerSessionId: "provider-session-1",
      providerInstanceId: CODEX,
      capabilities: new Set<McpInvocationContext.McpCapability>(["agents"]),
      issuedAt: 1,
    }),
  );

const tools = {
  list: (caller: ThreadId, params: TaskListInput = {}) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_list", params), TaskListResult, caller),
    ),
  delete: (caller: ThreadId, params: TaskDeleteInput) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_delete", params), TaskDeleteResult, caller),
    ),
  restore: (caller: ThreadId, params: TaskRestoreInput) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_restore", params), TaskRestoreResult, caller),
    ),
  intent: (caller: ThreadId, params: TaskIntentSetInput) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_intent_set", params), TaskIntentSetResult, caller),
    ),
  reorder: (caller: ThreadId, params: TaskReorderInput) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_reorder", params), TaskReorderResult, caller),
    ),
  bulk: (caller: ThreadId, params: TaskBulkInput) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_bulk", params), TaskBulkResult, caller),
    ),
  respond: (caller: ThreadId, params: TaskProposalRespondInput) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_proposal_respond", params), TaskBulkResult, caller),
    ),
  handoff: (caller: ThreadId, params: TaskHandoffInput) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_handoff", params), TaskBulkResult, caller),
    ),
  propose: (caller: ThreadId, params: TaskProposeInput) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_propose", params), TaskProposeResult, caller),
    ),
  update: (caller: ThreadId, params: TaskUpdateInput) =>
    Effect.flatMap(AgentsToolkit, (toolkit) =>
      call(toolkit.handle("cp_task_update", params), TaskUpdateResult, caller),
    ),
};
const storedTask = (taskId: string) =>
  Effect.gen(function* () {
    const model = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
    return model.tasks?.find((task) => task.id === taskId);
  });

const errorOf = <A, E extends { readonly _tag: string; readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.flip(effect).pipe(Effect.map((error) => ({ tag: error._tag, message: error.message })));

describe("cp_task_propose", () => {
  it.effect("a coordinator proposes a task for a specific day with a reminder", () =>
    run(
      Effect.gen(function* () {
        useAssistant({});
        const result = yield* tools.propose(ACME_COORD, {
          title: "Verify ISN integration in prod",
          date: "2026-11-16",
          reminderTime: "09:00",
        });
        expect(result.added).toBe(false);
        expect(result.proposed).toBe(1);
        expect(result.task.home).toEqual({
          kind: "date",
          date: "2026-11-16",
          reminderTime: "09:00",
        });
        expect(result.task.proposal?.projectId).toBe(ACME);
        expect(result.task.proposal?.acceptedAt).toBeUndefined();
      }),
    ),
  );

  it.effect("keeps the old `when` values and supports next periods and horizon backlogs", () =>
    run(
      Effect.gen(function* () {
        useAssistant({});
        const legacy = yield* tools.propose(ACME_COORD, { title: "Legacy", when: "this-month" });
        expect(legacy.task.home).toEqual({
          kind: "period",
          horizon: "month",
          startsOn: "2026-11-01",
          endsOn: "2026-11-30",
        });
        const fallback = yield* tools.propose(ACME_COORD, { title: "Default" });
        expect(fallback.task.home).toMatchObject({ kind: "period", horizon: "week" });
        const nextWeek = yield* tools.propose(ACME_COORD, { title: "Next", when: "next-week" });
        expect(nextWeek.task.home).toEqual({
          kind: "period",
          horizon: "week",
          startsOn: "2026-11-16",
          endsOn: "2026-11-22",
        });
        const backlog = yield* tools.propose(ACME_COORD, { title: "Later", when: "year-backlog" });
        expect(backlog.task.home).toEqual({ kind: "backlog", horizon: "year" });
        const month = yield* tools.propose(ACME_COORD, {
          title: "February",
          date: "2027-02-14",
          period: "month",
        });
        expect(month.task.home).toEqual({
          kind: "period",
          horizon: "month",
          startsOn: "2027-02-01",
          endsOn: "2027-02-28",
        });
      }),
    ),
  );

  it.effect("refuses an unreal date, a reminder off a day, and conflicting fields", () =>
    run(
      Effect.gen(function* () {
        useAssistant({});
        expect(
          (yield* errorOf(tools.propose(ACME_COORD, { title: "A", date: "2026-02-30" }))).message,
        ).toMatch(/not a real date/);
        expect(
          (yield* errorOf(
            tools.propose(ACME_COORD, { title: "A", when: "this-week", reminderTime: "09:00" }),
          )).message,
        ).toMatch(/single day/);
        expect(
          (yield* errorOf(
            tools.propose(ACME_COORD, { title: "A", when: "today", date: "2026-11-16" }),
          )).message,
        ).toMatch(/not both/);
      }),
    ),
  );

  it.effect("the Assistant proposes when its settings say propose", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit", newTasks: "propose" });
        const result = yield* tools.propose(ASSISTANT, { title: "Call the bank", when: "today" });
        expect(result.added).toBe(false);
        expect(result.task.proposal?.projectId).toBe(HOME);
      }),
    ),
  );

  it.effect("the Assistant adds directly when its settings say create, from any channel", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit", newTasks: "create" });
        const result = yield* tools.propose(ASSISTANT, {
          title: "Verify ISN integration in prod",
          date: "2026-11-16",
        });
        expect(result.added).toBe(true);
        expect(result.task.proposal).toBeUndefined();
        expect(result.task.home).toEqual({ kind: "date", date: "2026-11-16" });
        const fromChannel = yield* tools.propose(ASSISTANT_CHANNEL, { title: "Book flights" });
        expect(fromChannel.added).toBe(true);
      }),
    ),
  );

  it.effect("the Assistant only proposes when task access is read only", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "read", newTasks: "create" });
        const result = yield* tools.propose(ASSISTANT, { title: "Call the bank" });
        expect(result.added).toBe(false);
        expect(result.task.proposal).toBeDefined();
      }),
    ),
  );

  it.effect("coordinators keep proposing even when the Assistant adds directly", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit", newTasks: "create" });
        const result = yield* tools.propose(ACME_COORD, { title: "Approve copy" });
        expect(result.added).toBe(false);
        expect(result.task.proposal?.acceptedAt).toBeUndefined();
      }),
    ),
  );

  it.effect("refuses the Assistant with task access off, and non-coordinator agents", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "off" });
        const off = yield* errorOf(tools.propose(ASSISTANT, { title: "Call the bank" }));
        expect(off.tag).toBe("TaskAccessDeniedError");
        expect(off.message).toMatch(/turned off/);
        const agent = yield* errorOf(tools.propose(ACME_STANDING, { title: "Call the bank" }));
        expect(agent.tag).toBe("TaskAccessDeniedError");
      }),
    ),
  );
});

describe("cp_task_list", () => {
  it.effect("the Assistant sees every open task; a coordinator only its Project's", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "read" });
        yield* tools.propose(OTHER_COORD, { title: "Other's task" });
        const all = yield* tools.list(ASSISTANT);
        expect(all.tasks.map((task) => task.title).toSorted()).toEqual([
          "Other's task",
          "Renew passport",
        ]);
        const acme = yield* tools.list(ACME_COORD);
        expect(acme.tasks).toEqual([]);
        useAssistant({ tasks: "off" });
        expect((yield* errorOf(tools.list(ASSISTANT))).tag).toBe("TaskAccessDeniedError");
      }),
    ),
  );
});

describe("cp_task_update", () => {
  it.effect("the Assistant with edit access moves, renames and completes any task", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        const moved = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("user-task"),
          title: "Renew passport online",
          date: "2026-11-16",
          reminderTime: "08:15",
          notes: "Form DS-82",
        });
        expect(moved.task).toMatchObject({
          title: "Renew passport online",
          notes: "Form DS-82",
          home: { kind: "date", date: "2026-11-16", reminderTime: "08:15" },
        });
        // A new day keeps the reminder; null clears it.
        const later = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("user-task"),
          date: "2026-11-17",
        });
        expect(later.task.home).toEqual({
          kind: "date",
          date: "2026-11-17",
          reminderTime: "08:15",
        });
        const cleared = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("user-task"),
          reminderTime: null,
        });
        expect(cleared.task.home).toEqual({ kind: "date", date: "2026-11-17" });
        const done = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("user-task"),
          status: "completed",
        });
        expect(done.task.status).toBe("completed");
        expect(done.task.completedAt).toBeDefined();
        const reopened = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("user-task"),
          status: "todo",
        });
        expect(reopened.task.status).toBe("todo");
        const committed = yield* tools.update(ASSISTANT_CHANNEL, {
          taskId: TaskId.make("user-task"),
          when: "next-month",
        });
        expect(committed.task.home).toEqual({
          kind: "period",
          horizon: "month",
          startsOn: "2026-12-01",
          endsOn: "2026-12-31",
        });
      }),
    ),
  );

  it.effect("refuses the Assistant with read-only or off task access", () =>
    run(
      Effect.gen(function* () {
        for (const tasks of ["read", "off"] as const) {
          useAssistant({ tasks });
          const error = yield* errorOf(
            tools.update(ASSISTANT, { taskId: TaskId.make("user-task"), when: "today" }),
          );
          expect(error.tag).toBe("TaskAccessDeniedError");
          expect(error.message).toMatch(tasks === "read" ? /Read only/ : /turned off/);
        }
        expect((yield* storedTask("user-task"))?.home).toEqual({ kind: "backlog", horizon: null });
      }),
    ),
  );

  it.effect("the Assistant may move a waiting proposal but never accept it", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        const proposed = yield* tools.propose(ACME_COORD, { title: "Approve copy" });
        const moved = yield* tools.update(ASSISTANT, { taskId: proposed.task.id, when: "today" });
        expect(moved.task.home).toEqual({ kind: "date", date: "2026-11-13" });
        expect(moved.task.proposal?.acceptedAt).toBeUndefined();
        const error = yield* errorOf(
          tools.update(ASSISTANT, { taskId: proposed.task.id, status: "completed" }),
        );
        expect(error.message).toMatch(/still a proposal/);
      }),
    ),
  );

  it.effect("a coordinator edits only its own Project's tasks and never completes them", () =>
    run(
      Effect.gen(function* () {
        useAssistant({});
        const own = yield* tools.propose(ACME_COORD, { title: "Approve copy" });
        const moved = yield* tools.update(ACME_COORD, {
          taskId: own.task.id,
          date: "2026-11-20",
          title: "Approve email copy",
        });
        expect(moved.task).toMatchObject({
          title: "Approve email copy",
          home: { kind: "date", date: "2026-11-20" },
        });
        expect(moved.task.proposal?.acceptedAt).toBeUndefined();

        const status = yield* errorOf(
          tools.update(ACME_COORD, { taskId: own.task.id, status: "completed" }),
        );
        expect(status.message).toMatch(/Only the user completes/);

        const others = yield* errorOf(
          tools.update(OTHER_COORD, { taskId: own.task.id, when: "today" }),
        );
        expect(others.message).toMatch(/only edit tasks this Project proposed/);

        const users = yield* errorOf(
          tools.update(ACME_COORD, { taskId: TaskId.make("user-task"), when: "today" }),
        );
        expect(users.message).toMatch(/only edit tasks this Project proposed/);

        const agent = yield* errorOf(
          tools.update(ACME_STANDING, { taskId: own.task.id, when: "today" }),
        );
        expect(agent.tag).toBe("TaskAccessDeniedError");
      }),
    ),
  );

  it.effect("refuses an empty edit and a missing task", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        expect(
          (yield* errorOf(tools.update(ASSISTANT, { taskId: TaskId.make("user-task") }))).message,
        ).toMatch(/Nothing to change/);
        expect(
          (yield* errorOf(tools.update(ASSISTANT, { taskId: TaskId.make("nope"), when: "today" })))
            .message,
        ).toMatch(/no longer exists/);
      }),
    ),
  );
});

describe("task agent commands in the decider", () => {
  it.effect("refuse a direct add from anyone but the Assistant", () =>
    run(
      Effect.gen(function* () {
        const outcome = yield* Effect.exit(
          dispatch({
            type: "task.agent.create",
            commandId: cid(),
            taskId: TaskId.make("sneaky"),
            actorThreadId: ACME_COORD,
            title: "Sneaky",
            home: { kind: "backlog", horizon: null },
            createdAt: NOW,
          }),
        );
        expect(outcome._tag).toBe("Failure");
        expect(yield* storedTask("sneaky")).toBeUndefined();
      }),
    ),
  );

  it.effect("complete a repeating task's occurrence and open the next one", () =>
    run(
      Effect.gen(function* () {
        yield* dispatch({
          type: "task.create",
          commandId: cid(),
          taskId: TaskId.make("weekly"),
          title: "Weekly review",
          home: { kind: "date", date: "2026-11-13" },
          recurrence: { frequency: "weekly", interval: 1 },
          createdAt: SEEDED_AT,
        });
        useAssistant({ tasks: "edit" });
        yield* tools.update(ASSISTANT, { taskId: TaskId.make("weekly"), status: "completed" });
        const model = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
        const open = (model.tasks ?? []).filter(
          (task: Task) => task.title === "Weekly review" && task.status === "todo",
        );
        expect(open.map((task) => task.home)).toEqual([{ kind: "date", date: "2026-11-20" }]);
      }),
    ),
  );
});

// ── Listing, cancelling, deleting, restoring and reordering ─────────

const addTask = (id: string, title: string, home: Task["home"], extra: object = {}) =>
  dispatch({
    type: "task.create",
    commandId: cid(),
    taskId: TaskId.make(id),
    title,
    home,
    createdAt: SEEDED_AT,
    ...extra,
  });

const day = (date: string) => ({ kind: "date", date }) as const;

/** A week of tasks around Friday 2026-11-13 (weeks start Monday the 9th). */
const seedWeek = Effect.gen(function* () {
  yield* addTask("run-fri", "Run, 30 min", day("2026-11-13"));
  yield* addTask("lift-sat", "Gym lift, 45 min", day("2026-11-14"), {
    notes: "Upper body",
  });
  yield* addTask("old", "File expenses", day("2026-11-10"));
  yield* addTask("next", "Dentist", day("2026-11-18"));
  yield* addTask("week-goal", "Ship task tools", {
    kind: "period",
    horizon: "week",
    startsOn: "2026-11-09",
    endsOn: "2026-11-15",
  });
  yield* addTask("someday", "Learn Rust", { kind: "backlog", horizon: "year" });
});

describe("taskListWindow", () => {
  it("resolves ranges from the local today and refuses conflicting filters", () => {
    const today = "2026-11-13";
    expect(taskListWindow({ range: "this-week" }, today)).toEqual({
      kind: "span",
      from: "2026-11-09",
      to: "2026-11-15",
    });
    expect(taskListWindow({ range: "next-month" }, today)).toEqual({
      kind: "span",
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(taskListWindow({ range: "upcoming", days: 3 }, today)).toEqual({
      kind: "span",
      from: "2026-11-13",
      to: "2026-11-15",
    });
    expect(taskListWindow({ range: "overdue" }, today)).toEqual({
      kind: "span",
      from: null,
      to: "2026-11-12",
      openOnly: true,
    });
    expect(taskListWindow({ range: "any-backlog" }, today)).toEqual({
      kind: "backlog",
      horizon: "any",
    });
    expect(taskListWindow({}, today)).toBeNull();
    expect(taskListWindow({ date: "2026-11-14", range: "today" }, today)).toMatch(/not both/);
    expect(taskListWindow({ days: 3 }, today)).toMatch(/upcoming/);
    expect(taskListWindow({ date: "2026-02-30" }, today)).toMatch(/not a real date/);
  });
});

describe("planTaskReorder", () => {
  it("writes one key for one move between keyed neighbours, like a drag", () => {
    const list = [
      { id: TaskId.make("a"), orderKey: "d" as never },
      { id: TaskId.make("b"), orderKey: "h" as never },
      { id: TaskId.make("c"), orderKey: "p" as never },
    ];
    const plan = planTaskReorder(list, ["a", "c", "b"]);
    expect(plan.map((entry) => entry.id)).toEqual(["c"]);
    expect(plan[0]!.orderKey > "d" && plan[0]!.orderKey < "h").toBe(true);
    expect(planTaskReorder(list, ["a", "b", "c"])).toEqual([]);
  });

  it("materializes keys when the list has never been arranged", () => {
    const list = [
      { id: TaskId.make("a"), orderKey: null },
      { id: TaskId.make("b"), orderKey: null },
    ];
    const plan = new Map(planTaskReorder(list, ["b", "a"]).map((e) => [e.id, e.orderKey]));
    expect(plan.get("b")! < plan.get("a")!).toBe(true);
  });
});

describe("cp_task_list filters", () => {
  it.effect("filters by range, date, text, status and backlog, in display order", () =>
    run(
      Effect.gen(function* () {
        yield* seedWeek;
        useAssistant({ tasks: "read" });
        const titles = (result: { readonly tasks: ReadonlyArray<{ readonly title: string }> }) =>
          result.tasks.map((task) => task.title);
        expect(titles(yield* tools.list(ASSISTANT, { range: "this-week" }))).toEqual([
          "File expenses",
          "Run, 30 min",
          "Gym lift, 45 min",
          "Ship task tools",
        ]);
        expect(titles(yield* tools.list(ASSISTANT, { date: "2026-11-14" }))).toEqual([
          "Gym lift, 45 min",
          "Ship task tools",
        ]);
        expect(titles(yield* tools.list(ASSISTANT, { range: "overdue" }))).toEqual([
          "File expenses",
        ]);
        expect(titles(yield* tools.list(ASSISTANT, { text: "UPPER" }))).toEqual([
          "Gym lift, 45 min",
        ]);
        expect(titles(yield* tools.list(ASSISTANT, { range: "year-backlog" }))).toEqual([
          "Learn Rust",
        ]);
        expect(titles(yield* tools.list(ASSISTANT, { range: "any-backlog" }))).toEqual([
          "Learn Rust",
          "Renew passport",
        ]);
        const lift = (yield* tools.list(ASSISTANT, { text: "lift" })).tasks[0]!;
        expect(lift).toMatchObject({
          id: "lift-sat",
          notes: "Upper body",
          status: "todo",
          home: day("2026-11-14"),
          synced: false,
        });
        expect((yield* tools.list(ASSISTANT, { status: "completed" })).tasks).toEqual([]);
      }),
    ),
  );

  it.effect("pages with limit and cursor, and filters by linked Project", () =>
    run(
      Effect.gen(function* () {
        yield* seedWeek;
        useAssistant({ tasks: "read" });
        const first = yield* tools.list(ASSISTANT, { limit: 4 });
        expect(first.total).toBe(7);
        expect(first.tasks).toHaveLength(4);
        const second = yield* tools.list(ASSISTANT, { limit: 4, cursor: first.nextCursor! });
        expect(second.tasks).toHaveLength(3);
        expect(second.nextCursor).toBeUndefined();
        const ids = [...first.tasks, ...second.tasks].map((task) => task.id);
        expect(new Set(ids).size).toBe(7);
        expect((yield* errorOf(tools.list(ASSISTANT, { cursor: "x" }))).message).toMatch(/cursor/);
        yield* tools.propose(OTHER_COORD, { title: "Other's task" });
        expect(
          (yield* tools.list(ASSISTANT, { projectId: OTHER })).tasks.map((task) => task.title),
        ).toEqual(["Other's task"]);
      }),
    ),
  );

  it.effect("a coordinator's filters stay inside its own Project", () =>
    run(
      Effect.gen(function* () {
        yield* seedWeek;
        useAssistant({});
        yield* tools.propose(ACME_COORD, { title: "Approve copy", date: "2026-11-14" });
        const own = yield* tools.list(ACME_COORD, { date: "2026-11-14", status: "any" });
        expect(own.tasks.map((task) => task.title)).toEqual(["Approve copy"]);
        expect((yield* tools.list(ACME_COORD, { projectId: OTHER })).tasks).toEqual([]);
      }),
    ),
  );
});

describe("cp_task_update cancel and cp_task_restore", () => {
  it.effect("cancels a task like the user's Cancel, and restores it to todo", () =>
    run(
      Effect.gen(function* () {
        yield* seedWeek;
        useAssistant({ tasks: "edit" });
        const cancelled = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("lift-sat"),
          status: "cancelled",
        });
        expect(cancelled.task.status).toBe("cancelled");
        expect(cancelled.task.completedAt).toBeDefined();
        expect((yield* tools.list(ASSISTANT, { range: "this-week" })).tasks).toHaveLength(3);
        expect(
          (yield* tools.list(ASSISTANT, { status: "cancelled" })).tasks.map((task) => task.id),
        ).toEqual(["lift-sat"]);
        const restored = yield* tools.restore(ASSISTANT, { taskId: TaskId.make("lift-sat") });
        expect(restored.restored).toBe("cancelled");
        expect(restored.task.status).toBe("todo");
        expect(restored.task.completedAt).toBeUndefined();
        expect(
          (yield* errorOf(tools.restore(ASSISTANT, { taskId: TaskId.make("lift-sat") }))).message,
        ).toMatch(/already on the list/);
      }),
    ),
  );

  it.effect("cancelling one occurrence of a repeating task opens no next one", () =>
    run(
      Effect.gen(function* () {
        yield* addTask("daily", "Stretch", day("2026-11-13"), {
          recurrence: { frequency: "daily", interval: 1 },
        });
        useAssistant({ tasks: "edit" });
        yield* tools.update(ASSISTANT, { taskId: TaskId.make("daily"), status: "cancelled" });
        const open = (yield* tools.list(ASSISTANT, { text: "stretch", status: "any" })).tasks;
        expect(open.map((task) => [task.id, task.status])).toEqual([["daily", "cancelled"]]);
      }),
    ),
  );

  it.effect("a coordinator never cancels, even its own proposal", () =>
    run(
      Effect.gen(function* () {
        useAssistant({});
        const own = yield* tools.propose(ACME_COORD, { title: "Approve copy" });
        expect(
          (yield* errorOf(tools.update(ACME_COORD, { taskId: own.task.id, status: "cancelled" })))
            .message,
        ).toMatch(/Only the user completes, cancels or reopens/);
      }),
    ),
  );
});

describe("cp_task_delete and cp_task_restore", () => {
  it.effect("deletes a task and restores it exactly as it was, under the same id", () =>
    run(
      Effect.gen(function* () {
        yield* seedWeek;
        useAssistant({ tasks: "edit" });
        const before = yield* storedTask("lift-sat");
        const deleted = yield* tools.delete(ASSISTANT, { taskId: TaskId.make("lift-sat") });
        expect(deleted).toEqual({ taskId: "lift-sat", title: "Gym lift, 45 min", synced: false });
        expect(yield* storedTask("lift-sat")).toBeUndefined();
        expect(
          (yield* errorOf(tools.delete(ASSISTANT, { taskId: TaskId.make("lift-sat") }))).message,
        ).toMatch(/cp_task_restore/);
        const restored = yield* tools.restore(ASSISTANT_CHANNEL, {
          taskId: TaskId.make("lift-sat"),
        });
        expect(restored.restored).toBe("deleted");
        const { updatedAt: _a, ...was } = before!;
        const { updatedAt: _b, ...now } = restored.task;
        expect(now).toEqual(was);
        expect(
          (yield* errorOf(tools.restore(ASSISTANT, { taskId: TaskId.make("never") }))).message,
        ).toMatch(/no task with that id/);
      }),
    ),
  );

  it.effect("restores a task the user deleted from the UI", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        yield* dispatch({
          type: "task.delete",
          commandId: cid(),
          taskId: TaskId.make("user-task"),
          createdAt: NOW,
        });
        const restored = yield* tools.restore(ASSISTANT, { taskId: TaskId.make("user-task") });
        expect(restored.task.title).toBe("Renew passport");
      }),
    ),
  );

  it.effect("refuses read-only access, coordinators, and waiting proposals", () =>
    run(
      Effect.gen(function* () {
        yield* seedWeek;
        for (const tasks of ["read", "off"] as const) {
          useAssistant({ tasks });
          const tags = [
            (yield* errorOf(tools.delete(ASSISTANT, { taskId: TaskId.make("lift-sat") }))).tag,
            (yield* errorOf(tools.restore(ASSISTANT, { taskId: TaskId.make("lift-sat") }))).tag,
            (yield* errorOf(
              tools.reorder(ASSISTANT, {
                taskId: TaskId.make("lift-sat"),
                beforeTaskId: TaskId.make("run-fri"),
              }),
            )).tag,
            (yield* errorOf(tools.intent(ASSISTANT, { horizon: "week", when: "this", text: "x" })))
              .tag,
          ];
          expect(tags).toEqual(Array(4).fill("TaskAccessDeniedError"));
        }
        useAssistant({ tasks: "edit" });
        const coordinator = yield* errorOf(
          tools.delete(ACME_COORD, { taskId: TaskId.make("lift-sat") }),
        );
        expect(coordinator.tag).toBe("TaskAccessDeniedError");
        expect(coordinator.message).toMatch(/coordinator deletes only its own Project's proposals/);
        expect(yield* storedTask("lift-sat")).toBeDefined();
      }),
    ),
  );

  it.effect("the decider refuses agent deletes and restores from anyone but the Assistant", () =>
    run(
      Effect.gen(function* () {
        yield* seedWeek;
        const del = yield* Effect.exit(
          dispatch({
            type: "task.agent.delete",
            commandId: cid(),
            taskId: TaskId.make("lift-sat"),
            actorThreadId: ACME_COORD,
            createdAt: NOW,
          }),
        );
        expect(del._tag).toBe("Failure");
        const record = (yield* storedTask("lift-sat"))!;
        const restore = yield* Effect.exit(
          dispatch({
            type: "task.agent.restore",
            commandId: cid(),
            taskId: TaskId.make("lift-sat"),
            actorThreadId: ASSISTANT,
            task: record,
            createdAt: NOW,
          }),
        );
        expect(restore._tag).toBe("Failure");
      }),
    ),
  );
});

describe("cp_task_reorder", () => {
  const backlog = { kind: "backlog", horizon: null } as const;
  const seedBacklog = Effect.gen(function* () {
    yield* addTask("b1", "One", backlog, { orderKey: "d" });
    yield* addTask("b2", "Two", backlog, { orderKey: "h" });
    yield* addTask("b3", "Three", backlog, { orderKey: "p" });
  });
  const order = Effect.map(
    Effect.flatMap(ProjectionSnapshotQuery, (query) => query.getCommandReadModel()),
    (model) =>
      (model.tasks ?? [])
        .filter((task) => task.home.kind === "backlog" && task.status === "todo")
        .toSorted(compareTaskOrder)
        .map((task) => task.id as string),
  );

  it.effect("moves one task before or after another in its list", () =>
    run(
      Effect.gen(function* () {
        yield* seedBacklog;
        useAssistant({ tasks: "edit" });
        const moved = yield* tools.reorder(ASSISTANT, {
          taskId: TaskId.make("b3"),
          beforeTaskId: TaskId.make("b1"),
        });
        expect(moved.tasks.map((task) => task.id)).toEqual(["b3", "b1", "b2", "user-task"]);
        yield* tools.reorder(ASSISTANT, {
          taskId: TaskId.make("b3"),
          afterTaskId: TaskId.make("b2"),
        });
        expect(yield* order).toEqual(["b1", "b2", "b3", "user-task"]);
      }),
    ),
  );

  it.effect("puts an ordered list of ids at the top, the rest following", () =>
    run(
      Effect.gen(function* () {
        yield* seedBacklog;
        useAssistant({ tasks: "edit" });
        yield* tools.reorder(ASSISTANT, {
          orderedTaskIds: [TaskId.make("user-task"), TaskId.make("b2")],
        });
        expect(yield* order).toEqual(["user-task", "b2", "b1", "b3"]);
      }),
    ),
  );

  it.effect("refuses tasks from another list, closed tasks, and malformed requests", () =>
    run(
      Effect.gen(function* () {
        yield* seedBacklog;
        yield* seedWeek;
        useAssistant({ tasks: "edit" });
        const message = (params: TaskReorderInput) =>
          Effect.map(errorOf(tools.reorder(ASSISTANT, params)), (error) => error.message);
        expect(
          yield* message({ orderedTaskIds: [TaskId.make("b1"), TaskId.make("run-fri")] }),
        ).toMatch(/another list/);
        expect(yield* message({ taskId: TaskId.make("b1") })).toMatch(/exactly one/);
        expect(
          yield* message({
            taskId: TaskId.make("b1"),
            beforeTaskId: TaskId.make("b2"),
            afterTaskId: TaskId.make("b3"),
          }),
        ).toMatch(/exactly one/);
        expect(yield* message({ orderedTaskIds: [TaskId.make("b1"), TaskId.make("b1")] })).toMatch(
          /only once/,
        );
        yield* tools.update(ASSISTANT, { taskId: TaskId.make("b2"), status: "completed" });
        expect(
          yield* message({ taskId: TaskId.make("b1"), afterTaskId: TaskId.make("b2") }),
        ).toMatch(/completed/);
        expect(
          (yield* errorOf(
            tools.reorder(ACME_COORD, {
              taskId: TaskId.make("b1"),
              beforeTaskId: TaskId.make("b3"),
            }),
          )).tag,
        ).toBe("TaskAccessDeniedError");
      }),
    ),
  );
});

describe("repeating tasks, links and intents (Lucive parity)", () => {
  const weekly = { frequency: "weekly", interval: 1 } as const;

  it.effect("adds a repeating task directly, edits its rule, and stops it", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit", newTasks: "create" });
        const added = yield* tools.propose(ASSISTANT, {
          title: "Weekly review",
          date: "2026-11-13",
          reminderTime: "16:00",
          recurrence: weekly,
          links: { projectId: ACME },
        });
        expect(added.added).toBe(true);
        expect(added.task).toMatchObject({
          recurrence: weekly,
          links: { projectId: ACME },
          home: { kind: "date", date: "2026-11-13", reminderTime: "16:00" },
        });
        const edited = yield* tools.update(ASSISTANT, {
          taskId: added.task.id,
          recurrence: { frequency: "weekly", interval: 2, daysOfWeek: [5] },
        });
        expect(edited.task.recurrence).toEqual({
          frequency: "weekly",
          interval: 2,
          daysOfWeek: [5],
        });
        expect(
          (yield* tools.list(ASSISTANT, { repeating: true })).tasks.map((task) => task.id),
        ).toEqual([added.task.id]);
        const stopped = yield* tools.update(ASSISTANT, { taskId: added.task.id, recurrence: null });
        expect(stopped.task.recurrence).toBeUndefined();
        expect(stopped.task.status).toBe("todo");
        expect((yield* tools.list(ASSISTANT, { repeating: true })).tasks).toEqual([]);
      }),
    ),
  );

  it.effect("makes a plain task repeat from its day, and refuses a repeat off a day", () =>
    run(
      Effect.gen(function* () {
        yield* seedWeek;
        useAssistant({ tasks: "edit" });
        const made = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("run-fri"),
          recurrence: { frequency: "daily", interval: 1 },
        });
        expect(made.task.recurrence).toEqual({ frequency: "daily", interval: 1 });
        const offDay = yield* errorOf(
          tools.update(ASSISTANT, { taskId: TaskId.make("run-fri"), when: "next-week" }),
        );
        expect(offDay.message).toMatch(/moves only between days/);
        const moved = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("run-fri"),
          date: "2026-11-16",
        });
        expect(moved.task.recurrence).toBeDefined();
        const backlog = yield* errorOf(
          tools.update(ASSISTANT, {
            taskId: TaskId.make("someday"),
            recurrence: { frequency: "daily", interval: 1 },
          }),
        );
        expect(backlog.message).toMatch(/moves only between days/);
        const ended = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("run-fri"),
          recurrence: null,
          when: "week-backlog",
        });
        expect(ended.task.home).toEqual({ kind: "backlog", horizon: "week" });
      }),
    ),
  );

  it.effect("skipping one occurrence opens the next; restoring brings the skipped one back", () =>
    run(
      Effect.gen(function* () {
        yield* addTask("weekly", "Gym lift", day("2026-11-14"), { recurrence: weekly });
        useAssistant({ tasks: "edit" });
        const skipped = yield* tools.delete(ASSISTANT, { taskId: TaskId.make("weekly") });
        expect(skipped.next).toMatchObject({
          title: "Gym lift",
          home: day("2026-11-21"),
          recurrence: weekly,
        });
        expect(yield* storedTask("weekly")).toBeUndefined();
        const restored = yield* tools.restore(ASSISTANT, { taskId: TaskId.make("weekly") });
        expect(restored.task.home).toEqual(day("2026-11-14"));
        expect(yield* storedTask(skipped.next!.id)).toBeDefined();
      }),
    ),
  );

  it.effect("deleting the series stops it, and restore brings the repeat back", () =>
    run(
      Effect.gen(function* () {
        yield* addTask("weekly", "Gym lift", day("2026-11-14"), { recurrence: weekly });
        useAssistant({ tasks: "edit" });
        const gone = yield* tools.delete(ASSISTANT, {
          taskId: TaskId.make("weekly"),
          scope: "series",
        });
        expect(gone.next).toBeUndefined();
        expect((yield* tools.list(ASSISTANT, { text: "gym", status: "any" })).tasks).toEqual([]);
        const restored = yield* tools.restore(ASSISTANT, { taskId: TaskId.make("weekly") });
        expect(restored.task.recurrence).toEqual(weekly);
        expect(
          (yield* errorOf(
            tools.delete(ASSISTANT, { taskId: TaskId.make("user-task"), scope: "series" }),
          )).message,
        ).toMatch(/does not repeat/);
      }),
    ),
  );

  it.effect("repeat and links stay with the user and the Assistant", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit", newTasks: "propose" });
        expect(
          (yield* errorOf(
            tools.propose(ASSISTANT, { title: "Stretch", when: "today", recurrence: weekly }),
          )).message,
        ).toMatch(/Add directly/);
        expect(
          (yield* errorOf(
            tools.propose(ACME_COORD, { title: "Stretch", when: "today", recurrence: weekly }),
          )).message,
        ).toMatch(/proposal cannot repeat/);
        const own = yield* tools.propose(ACME_COORD, { title: "Approve copy", when: "today" });
        expect(
          (yield* errorOf(tools.update(ACME_COORD, { taskId: own.task.id, links: null }))).message,
        ).toMatch(/repeat, links/);
        const relinked = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("user-task"),
          links: { threadId: ACME_STANDING },
        });
        expect(relinked.task.links).toEqual({ projectId: ACME, threadId: ACME_STANDING });
        const cleared = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("user-task"),
          links: null,
        });
        expect(cleared.task.links).toBeUndefined();
      }),
    ),
  );

  it.effect("sets and clears period intents, and lists them with the range", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        const set = yield* tools.intent(ASSISTANT, {
          horizon: "week",
          when: "this",
          text: "Ship task tools",
        });
        expect(set).toMatchObject({
          startsOn: "2026-11-09",
          endsOn: "2026-11-15",
          intent: { text: "Ship task tools" },
        });
        yield* tools.intent(ASSISTANT, { horizon: "month", date: "2026-12-04", text: "Rest" });
        expect(
          (yield* tools.list(ASSISTANT, { date: "2026-11-14" })).intents.map((i) => i.text),
        ).toEqual(["Ship task tools"]);
        expect(
          (yield* tools.list(ASSISTANT, { range: "next-month" })).intents.map((i) => i.text),
        ).toEqual(["Rest"]);
        const cleared = yield* tools.intent(ASSISTANT, { horizon: "week", when: "this", text: "" });
        expect(cleared.intent).toBeNull();
        expect(
          (yield* errorOf(tools.intent(ASSISTANT, { horizon: "week", text: "x" }))).message,
        ).toMatch(/either `when` or `date`/);
        useAssistant({});
        expect(
          (yield* errorOf(tools.intent(ACME_COORD, { horizon: "week", when: "this", text: "x" })))
            .tag,
        ).toBe("TaskAccessDeniedError");
      }),
    ),
  );
});

describe("week intents follow the synced week start", () => {
  const savedWeekStart = getTaskWeekStartsOn();
  afterEach(() => setTaskWeekStartsOn(savedWeekStart));

  // 2026-11-16 is a Monday. A Monday-start week begins that day; a
  // Sunday-start week began the day before.
  it.effect.each([
    { weekStartsOn: 1, startsOn: "2026-11-16", endsOn: "2026-11-22" },
    { weekStartsOn: 0, startsOn: "2026-11-15", endsOn: "2026-11-21" },
  ])(
    "keys Monday's intent by the week starting $startsOn when weeks start on day $weekStartsOn",
    ({ weekStartsOn, startsOn, endsOn }) =>
      run(
        Effect.gen(function* () {
          setTaskWeekStartsOn(weekStartsOn);
          useAssistant({ tasks: "edit" });
          const set = yield* tools.intent(ASSISTANT, {
            horizon: "week",
            date: "2026-11-16",
            text: "Get ISN live and check in with every trial",
          });
          expect(set).toMatchObject({ startsOn, endsOn });
          const listed = yield* tools.list(ASSISTANT, { date: "2026-11-16" });
          expect(listed.intents).toEqual([expect.objectContaining({ horizon: "week", startsOn })]);
          // The same key a view finds by asking for the week containing that day.
          const model = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
          expect(
            model.taskIntents?.find(
              (intent) =>
                intent.horizon === "week" &&
                intent.startsOn === taskPeriodFor("week", "2026-11-16", weekStartsOn).startsOn,
            )?.text,
          ).toBe("Get ISN live and check in with every trial");
        }),
      ),
  );
});

describe("repeat end conditions and the user's Delete (Lucive parity)", () => {
  const weekly = { frequency: "weekly", interval: 1 } as const;

  it.effect("a series that ends after N occurrences stops opening new ones", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit", newTasks: "create" });
        const added = yield* tools.propose(ASSISTANT, {
          title: "Physio",
          date: "2026-11-13",
          recurrence: { ...weekly, endAfterCount: 2, occurrence: 7 },
        });
        expect(added.task.recurrence).toEqual({ ...weekly, endAfterCount: 2, occurrence: 1 });
        // Skipping does not count toward the end.
        const skipped = yield* tools.delete(ASSISTANT, { taskId: added.task.id });
        expect(skipped.next?.recurrence?.occurrence).toBe(1);
        yield* tools.update(ASSISTANT, { taskId: skipped.next!.id, status: "completed" });
        const open = (yield* tools.list(ASSISTANT, { text: "physio" })).tasks;
        expect(open.map((task) => [task.home, task.recurrence?.occurrence])).toEqual([
          [day("2026-11-27"), 2],
        ]);
        yield* tools.update(ASSISTANT, { taskId: open[0]!.id, status: "completed" });
        expect((yield* tools.list(ASSISTANT, { text: "physio" })).tasks).toEqual([]);
      }),
    ),
  );

  it.effect("a series that ends on a date opens nothing after it", () =>
    run(
      Effect.gen(function* () {
        yield* addTask("weekly", "Gym lift", day("2026-11-14"), { recurrence: weekly });
        useAssistant({ tasks: "edit" });
        const dated = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("weekly"),
          recurrence: { ...weekly, endAfterDate: "2026-11-21" },
        });
        expect(dated.task.recurrence).toEqual({ ...weekly, endAfterDate: "2026-11-21" });
        yield* tools.update(ASSISTANT, { taskId: TaskId.make("weekly"), status: "completed" });
        const next = (yield* tools.list(ASSISTANT, { text: "gym" })).tasks;
        expect(next.map((task) => task.home)).toEqual([day("2026-11-21")]);
        yield* tools.update(ASSISTANT, { taskId: next[0]!.id, status: "completed" });
        expect((yield* tools.list(ASSISTANT, { text: "gym" })).tasks).toEqual([]);
        expect(
          (yield* errorOf(
            tools.update(ASSISTANT, {
              taskId: TaskId.make("user-task"),
              date: "2026-11-20",
              recurrence: { ...weekly, endAfterDate: "2026-02-30" },
            }),
          )).message,
        ).toMatch(/not a date/);
      }),
    ),
  );

  it.effect("the user's Delete skips one occurrence or stops the series, like the tool", () =>
    run(
      Effect.gen(function* () {
        yield* addTask("weekly", "Gym lift", day("2026-11-14"), { recurrence: weekly });
        yield* dispatch({
          type: "task.delete",
          commandId: cid(),
          taskId: TaskId.make("weekly"),
          createdAt: NOW,
        });
        const model = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
        const next = (model.tasks ?? []).find((task) => task.title === "Gym lift")!;
        expect(next.home).toEqual(day("2026-11-21"));
        expect(next.recurrence).toEqual(weekly);
        yield* dispatch({
          type: "task.delete",
          commandId: cid(),
          taskId: next.id,
          scope: "series",
          createdAt: NOW,
        });
        const after = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
        expect((after.tasks ?? []).filter((task) => task.title === "Gym lift")).toEqual([]);
        const plain = yield* Effect.exit(
          dispatch({
            type: "task.delete",
            commandId: cid(),
            taskId: TaskId.make("user-task"),
            scope: "series",
            createdAt: NOW,
          }),
        );
        expect(plain._tag).toBe("Failure");
      }),
    ),
  );
});

describe("proposals: withdraw, edit, add and dismiss", () => {
  it.effect("the Assistant withdraws its own proposal and any other, and can restore one", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit", newTasks: "propose" });
        const mine = yield* tools.propose(ASSISTANT, { title: "Call the bank" });
        const withdrawn = yield* tools.delete(ASSISTANT, { taskId: mine.task.id });
        expect(withdrawn.withdrawn).toBe(true);
        expect(yield* storedTask(mine.task.id)).toBeUndefined();
        const restored = yield* tools.restore(ASSISTANT, { taskId: mine.task.id });
        expect(restored.task.proposal?.acceptedAt).toBeUndefined();
        expect(restored.task.title).toBe("Call the bank");
        const theirs = yield* tools.propose(ACME_COORD, { title: "Approve copy" });
        yield* tools.delete(ASSISTANT, { taskId: theirs.task.id });
        expect(yield* storedTask(theirs.task.id)).toBeUndefined();
        const scoped = yield* errorOf(
          tools.delete(ASSISTANT, { taskId: mine.task.id, scope: "series" }),
        );
        expect(scoped.message).toMatch(/does not repeat/);
      }),
    ),
  );

  it.effect("a coordinator withdraws and edits only its own Project's proposals", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        const own = yield* tools.propose(ACME_COORD, { title: "Approve copy" });
        const other = yield* tools.propose(OTHER_COORD, { title: "Sign NDA" });
        const edited = yield* tools.update(ACME_COORD, {
          taskId: own.task.id,
          title: "Approve email copy",
          notes: "v2",
          when: "tomorrow",
        });
        expect(edited.task).toMatchObject({ title: "Approve email copy", notes: "v2" });
        const denied = yield* errorOf(tools.delete(ACME_COORD, { taskId: other.task.id }));
        expect(denied.tag).toBe("TaskAccessDeniedError");
        expect((yield* tools.delete(ACME_COORD, { taskId: own.task.id })).withdrawn).toBe(true);
        expect(yield* storedTask(own.task.id)).toBeUndefined();
        expect(yield* storedTask(other.task.id)).toBeDefined();
        // Once the user adds it, it is theirs: the coordinator can no longer delete it.
        const later = yield* tools.propose(ACME_COORD, { title: "Review pricing" });
        yield* dispatch({
          type: "task.proposal.respond",
          commandId: cid(),
          taskId: later.task.id,
          accept: true,
          createdAt: SEEDED_AT,
        });
        expect((yield* errorOf(tools.delete(ACME_COORD, { taskId: later.task.id }))).tag).toBe(
          "TaskAccessDeniedError",
        );
        // And it never adds or dismisses proposals.
        const respond = yield* errorOf(
          tools.respond(ACME_COORD, { taskIds: [other.task.id], accept: true }),
        );
        expect(respond.tag).toBe("TaskAccessDeniedError");
        expect(respond.message).toMatch(/withdraw it with cp_task_delete/);
      }),
    ),
  );

  it.effect("the Assistant adds or dismisses proposals by id or by Project (Add all)", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        const one = yield* tools.propose(ACME_COORD, { title: "One" });
        const two = yield* tools.propose(ACME_COORD, { title: "Two" });
        const other = yield* tools.propose(OTHER_COORD, { title: "Other" });
        const added = yield* tools.respond(ASSISTANT, {
          taskIds: [one.task.id],
          accept: true,
          date: "2026-11-16",
          reminderTime: "09:00",
        });
        expect(added.succeeded).toBe(1);
        expect(added.results[0]?.task?.proposal?.acceptedAt).toBeDefined();
        expect(added.results[0]?.task?.home).toEqual({
          kind: "date",
          date: "2026-11-16",
          reminderTime: "09:00",
        });
        // Already added: reported, the rest still done.
        const again = yield* tools.respond(ASSISTANT, {
          taskIds: [one.task.id, two.task.id],
          accept: true,
        });
        expect(again).toMatchObject({ succeeded: 1, failed: 1 });
        expect(again.results[0]?.error).toMatch(/not a proposal waiting/);
        const dismissed = yield* tools.respond(ASSISTANT, { projectId: OTHER, accept: false });
        expect(dismissed.results.map((entry) => entry.taskId)).toEqual([other.task.id]);
        expect(dismissed.results[0]?.task).toBeNull();
        expect(yield* storedTask(other.task.id)).toBeUndefined();
        expect(
          (yield* errorOf(tools.respond(ASSISTANT, { projectId: OTHER, accept: true }))).message,
        ).toMatch(/no proposals waiting/);
        expect(
          (yield* errorOf(
            tools.respond(ASSISTANT, { taskIds: [two.task.id], accept: false, when: "today" }),
          )).message,
        ).toMatch(/only with accept/);
        useAssistant({ tasks: "read" });
        expect(
          (yield* errorOf(tools.respond(ASSISTANT, { projectId: ACME, accept: true }))).tag,
        ).toBe("TaskAccessDeniedError");
      }),
    ),
  );

  it.effect("the decider keeps add and dismiss from coordinators, and withdraws per Project", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        const own = yield* tools.propose(ACME_COORD, { title: "Approve copy" });
        const respond = yield* Effect.exit(
          dispatch({
            type: "task.agent.respond",
            commandId: cid(),
            taskId: own.task.id,
            actorThreadId: ACME_COORD,
            accept: true,
            createdAt: SEEDED_AT,
          }),
        );
        expect(respond._tag).toBe("Failure");
        const withdraw = yield* Effect.exit(
          dispatch({
            type: "task.agent.delete",
            commandId: cid(),
            taskId: own.task.id,
            actorThreadId: OTHER_COORD,
            createdAt: SEEDED_AT,
          }),
        );
        expect(withdraw._tag).toBe("Failure");
        const handoff = yield* Effect.exit(
          dispatch({
            type: "task.agent.handoff",
            commandId: cid(),
            taskId: TaskId.make("user-task"),
            actorThreadId: ACME_COORD,
            handoff: null,
            createdAt: SEEDED_AT,
          }),
        );
        expect(handoff._tag).toBe("Failure");
        expect(yield* storedTask(own.task.id)).toBeDefined();
      }),
    ),
  );

  it.effect("cp_task_list finds waiting proposals and handed-off tasks", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        const proposal = yield* tools.propose(ACME_COORD, { title: "Approve copy" });
        const waiting = yield* tools.list(ASSISTANT, { proposed: true });
        expect(waiting.tasks.map((task) => task.id)).toEqual([proposal.task.id]);
        const listed = yield* tools.list(ASSISTANT, { proposed: false });
        expect(listed.tasks.map((task) => task.id)).toEqual(["user-task"]);
        yield* tools.handoff(ASSISTANT, { taskIds: [TaskId.make("user-task")], to: "assistant" });
        const handed = yield* tools.list(ASSISTANT, { handedOff: true });
        expect(handed.tasks.map((task) => task.id)).toEqual(["user-task"]);
      }),
    ),
  );
});

describe("cp_task_handoff", () => {
  it.effect("hands tasks to the Assistant, a coordinator or an agent, and clears it", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        yield* addTask(
          "t2",
          "Book flights",
          { kind: "backlog", horizon: null },
          {
            links: { projectId: ACME },
          },
        );
        // The coordinator of the task's linked Project by default.
        const toCoordinator = yield* tools.handoff(ASSISTANT, {
          taskIds: [TaskId.make("t2"), TaskId.make("user-task")],
          to: "coordinator",
        });
        expect(toCoordinator.results[0]?.task?.handoff).toMatchObject({ threadId: ACME_COORD });
        expect(toCoordinator.results[1]?.error).toMatch(/no Project/);
        const named = yield* tools.handoff(ASSISTANT, {
          taskIds: [TaskId.make("user-task")],
          to: "coordinator",
          projectId: OTHER,
        });
        expect(named.results[0]?.task?.handoff).toMatchObject({ threadId: OTHER_COORD });
        const toAssistant = yield* tools.handoff(ASSISTANT, {
          taskIds: [TaskId.make("user-task"), TaskId.make("t2")],
          to: "assistant",
        });
        expect(toAssistant.succeeded).toBe(2);
        expect((yield* storedTask("user-task"))?.handoff).toMatchObject({
          kind: "coordinator",
          threadId: ASSISTANT,
        });
        const toAgent = yield* tools.handoff(ASSISTANT, {
          taskIds: [TaskId.make("t2")],
          to: "agent",
          threadId: ACME_STANDING,
        });
        expect(toAgent.results[0]?.task?.handoff).toMatchObject({
          kind: "agent",
          threadId: ACME_STANDING,
        });
        const cleared = yield* tools.handoff(ASSISTANT, {
          taskIds: [TaskId.make("t2"), TaskId.make("user-task")],
          to: "none",
        });
        expect(cleared.succeeded).toBe(2);
        expect((yield* storedTask("t2"))?.handoff).toBeUndefined();
        expect((yield* storedTask("user-task"))?.handoff).toBeUndefined();
      }),
    ),
  );

  it.effect("refuses coordinators, read-only access, proposals and bad targets", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        const proposal = yield* tools.propose(ACME_COORD, { title: "Approve copy" });
        const result = yield* tools.handoff(ASSISTANT, {
          taskIds: [proposal.task.id],
          to: "assistant",
        });
        expect(result.results[0]?.error).toMatch(/Add the proposed task/);
        expect(
          (yield* errorOf(
            tools.handoff(ASSISTANT, { taskIds: [TaskId.make("user-task")], to: "agent" }),
          )).message,
        ).toMatch(/threadId/);
        expect(
          (yield* errorOf(
            tools.handoff(ACME_COORD, { taskIds: [TaskId.make("user-task")], to: "assistant" }),
          )).tag,
        ).toBe("TaskAccessDeniedError");
        useAssistant({ tasks: "read" });
        expect(
          (yield* errorOf(
            tools.handoff(ASSISTANT, { taskIds: [TaskId.make("user-task")], to: "none" }),
          )).tag,
        ).toBe("TaskAccessDeniedError");
      }),
    ),
  );
});

describe("handoff messages", () => {
  const messagesOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly id: string;
        readonly role: string;
        readonly text: string;
        readonly source: string | null;
      }>`
        SELECT message_id AS id, role, text, source_json AS source
        FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND message_id LIKE '%:task-handoff:%'
        ORDER BY rowid
      `;
      return rows.map((row) => ({
        ...row,
        source: row.source === null ? undefined : (JSON.parse(row.source) as object),
      }));
    });

  it.effect("cp_task_handoff sends each receiving thread one message, never the caller", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        yield* addTask(
          "t2",
          "Book flights",
          { kind: "date", date: "2026-11-20" },
          {
            notes: "Window seat",
            links: { projectId: ACME },
          },
        );
        yield* addTask(
          "t3",
          "Pick hotel",
          { kind: "backlog", horizon: null },
          {
            links: { projectId: ACME },
          },
        );
        const toCoordinator = yield* tools.handoff(ASSISTANT, {
          taskIds: [TaskId.make("t2"), TaskId.make("t3")],
          to: "coordinator",
        });
        expect(toCoordinator.delivered).toEqual([ACME_COORD]);
        const [message] = yield* messagesOf(ACME_COORD);
        expect(message?.id).toMatch(/^cp-send:acme-coord:task-handoff:/);
        expect(message?.text).toContain("these 2 tasks");
        expect(message?.text).toContain("- Book flights (task t2)");
        expect(message?.text).toContain("Home: 2026-11-20");
        expect(message?.text).toContain("Project acme (acme)");
        expect(message?.text).toContain("Notes: Window seat");
        expect(message?.text).toContain("- Pick hotel (task t3)");
        expect(message?.text).toContain("Home: the general backlog");
        // The Assistant handing tasks to itself sends nothing.
        const self = yield* tools.handoff(ASSISTANT, {
          taskIds: [TaskId.make("user-task")],
          to: "assistant",
        });
        expect(self.delivered).toBeUndefined();
        expect(yield* messagesOf(ASSISTANT)).toEqual([]);
        // From a pinned channel, the Assistant's thread gets it, from that channel.
        const fromChannel = yield* tools.handoff(ASSISTANT_CHANNEL, {
          taskIds: [TaskId.make("user-task")],
          to: "assistant",
        });
        expect(fromChannel.delivered).toEqual([ASSISTANT]);
        const [handed] = yield* messagesOf(ASSISTANT);
        expect(handed?.text).toContain("- Renew passport (task user-task)");
        expect(handed?.source).toMatchObject({ kind: "agent", threadId: ASSISTANT_CHANNEL });
        // Clearing sends nothing.
        const cleared = yield* tools.handoff(ASSISTANT_CHANNEL, {
          taskIds: [TaskId.make("user-task")],
          to: "none",
        });
        expect(cleared.delivered).toBeUndefined();
      }),
    ),
  );

  it.effect("the user's Hand to Assistant sends the batch once, on its last handoff", () =>
    run(
      Effect.gen(function* () {
        yield* addTask("t2", "Book flights", { kind: "backlog", horizon: null });
        const handoff = { kind: "coordinator", threadId: ASSISTANT, at: SEEDED_AT } as const;
        yield* dispatch({
          type: "task.handoff",
          commandId: cid(),
          taskId: TaskId.make("user-task"),
          handoff,
          createdAt: SEEDED_AT,
        });
        const delivery = taskHandoffDeliveryId(ASSISTANT, "batch-1");
        yield* dispatch({
          type: "task.handoff",
          commandId: CommandId.make(delivery),
          taskId: TaskId.make("t2"),
          handoff,
          deliver: { taskIds: [TaskId.make("user-task"), TaskId.make("t2")] },
          createdAt: SEEDED_AT,
        });
        const messages = yield* messagesOf(ASSISTANT);
        expect(messages.map((message) => message.id)).toEqual([delivery]);
        expect(messages[0]?.role).toBe("user");
        expect(messages[0]?.source).toBeUndefined();
        expect(messages[0]?.text).toContain("Renew passport (task user-task)");
        expect((yield* storedTask("t2"))?.handoff?.threadId).toBe(ASSISTANT);
      }),
    ),
  );

  it.effect("the decider refuses a delivery that is malformed, and saves nothing", () =>
    run(
      Effect.gen(function* () {
        const handoff = { kind: "coordinator", threadId: ASSISTANT, at: SEEDED_AT } as const;
        const attempt = (overrides: object) =>
          Effect.exit(
            dispatch({
              type: "task.handoff",
              commandId: CommandId.make(taskHandoffDeliveryId(ASSISTANT, `x-${cid()}`)),
              taskId: TaskId.make("user-task"),
              handoff,
              deliver: { taskIds: [TaskId.make("user-task")] },
              createdAt: SEEDED_AT,
              ...overrides,
            } as OrchestrationCommand),
          );
        // A plain command id: the delivery ledger could not track the message.
        expect((yield* attempt({ commandId: cid() }))._tag).toBe("Failure");
        // The batch must include this task, and every task must exist.
        expect((yield* attempt({ deliver: { taskIds: [TaskId.make("nope")] } }))._tag).toBe(
          "Failure",
        );
        // Clearing a handoff sends nothing.
        expect((yield* attempt({ handoff: null }))._tag).toBe("Failure");
        expect((yield* storedTask("user-task"))?.handoff).toBeUndefined();
        expect(yield* messagesOf(ASSISTANT)).toEqual([]);
      }),
    ),
  );
});

describe("cp_task_bulk", () => {
  it.effect("moves, completes, reopens, cancels, deletes and restores many tasks", () =>
    run(
      Effect.gen(function* () {
        yield* seedWeek;
        useAssistant({ tasks: "edit" });
        const ids = [TaskId.make("run-fri"), TaskId.make("lift-sat"), TaskId.make("old")];
        const moved = yield* tools.bulk(ASSISTANT, {
          taskIds: ids,
          action: "move",
          date: "2026-11-20",
        });
        expect(moved.succeeded).toBe(3);
        for (const id of ids) {
          expect((yield* storedTask(id))?.home).toEqual({ kind: "date", date: "2026-11-20" });
        }
        const done = yield* tools.bulk(ASSISTANT, { taskIds: ids, action: "complete" });
        expect(done.results.map((entry) => entry.task?.status)).toEqual(Array(3).fill("completed"));
        yield* tools.bulk(ASSISTANT, { taskIds: ids, action: "reopen" });
        expect((yield* storedTask("old"))?.status).toBe("todo");
        yield* tools.bulk(ASSISTANT, { taskIds: [ids[0]!], action: "cancel" });
        expect((yield* storedTask("run-fri"))?.status).toBe("cancelled");
        const deleted = yield* tools.bulk(ASSISTANT, {
          taskIds: [...ids, TaskId.make("missing")],
          action: "delete",
        });
        expect(deleted).toMatchObject({ succeeded: 3, failed: 1 });
        expect(deleted.results[3]?.error).toMatch(/no longer exists/);
        for (const id of ids) expect(yield* storedTask(id)).toBeUndefined();
        const restored = yield* tools.bulk(ASSISTANT, { taskIds: ids, action: "restore" });
        expect(restored.succeeded).toBe(3);
        expect((yield* storedTask("lift-sat"))?.notes).toBe("Upper body");
      }),
    ),
  );

  it.effect("applies a delete scope to the repeating tasks among them only", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit", newTasks: "create" });
        const series = yield* tools.propose(ASSISTANT, {
          title: "Stretch",
          date: "2026-11-13",
          recurrence: { frequency: "daily", interval: 1 },
        });
        const result = yield* tools.bulk(ASSISTANT, {
          taskIds: [series.task.id, TaskId.make("user-task")],
          action: "delete",
          scope: "series",
        });
        expect(result.succeeded).toBe(2);
        const model = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
        expect((model.tasks ?? []).filter((task) => task.title === "Stretch")).toEqual([]);
      }),
    ),
  );

  it.effect("lets a coordinator move and withdraw only its own proposals", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        const one = yield* tools.propose(ACME_COORD, { title: "One" });
        const two = yield* tools.propose(ACME_COORD, { title: "Two" });
        const moved = yield* tools.bulk(ACME_COORD, {
          taskIds: [one.task.id, two.task.id, TaskId.make("user-task")],
          action: "move",
          when: "next-week",
        });
        expect(moved).toMatchObject({ succeeded: 2, failed: 1 });
        const withdrawn = yield* tools.bulk(ACME_COORD, {
          taskIds: [one.task.id, two.task.id],
          action: "delete",
        });
        expect(withdrawn.succeeded).toBe(2);
        expect(
          (yield* errorOf(
            tools.bulk(ACME_COORD, { taskIds: [TaskId.make("user-task")], action: "complete" }),
          )).tag,
        ).toBe("TaskAccessDeniedError");
      }),
    ),
  );

  it.effect("refuses malformed requests and read-only access", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        const id = TaskId.make("user-task");
        const message = (params: TaskBulkInput) =>
          Effect.map(errorOf(tools.bulk(ASSISTANT, params)), (error) => error.message);
        expect(yield* message({ taskIds: [id], action: "move" })).toMatch(/needs a home/);
        expect(yield* message({ taskIds: [id], action: "complete", when: "today" })).toMatch(
          /only with action move/,
        );
        expect(yield* message({ taskIds: [id], action: "complete", scope: "series" })).toMatch(
          /only with delete/,
        );
        expect(yield* message({ taskIds: [id, id], action: "complete" })).toMatch(/only once/);
        useAssistant({ tasks: "read" });
        expect(
          (yield* errorOf(tools.bulk(ASSISTANT, { taskIds: [id], action: "complete" }))).tag,
        ).toBe("TaskAccessDeniedError");
      }),
    ),
  );
});

describe("cp_task_reorder across lists", () => {
  it.effect("moves a task next to an anchor in another list, keeping its reminder", () =>
    run(
      Effect.gen(function* () {
        yield* seedWeek;
        useAssistant({ tasks: "edit" });
        yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("lift-sat"),
          reminderTime: "07:00",
        });
        yield* addTask("fri-2", "Groceries", day("2026-11-13"), { orderKey: "t" });
        const result = yield* tools.reorder(ASSISTANT, {
          taskId: TaskId.make("lift-sat"),
          beforeTaskId: TaskId.make("fri-2"),
        });
        // run-fri has no order key yet, so it sorts after the arranged ones.
        expect(result.tasks.map((task) => task.id)).toEqual(["lift-sat", "fri-2", "run-fri"]);
        expect((yield* storedTask("lift-sat"))?.home).toEqual({
          kind: "date",
          date: "2026-11-13",
          reminderTime: "07:00",
        });
      }),
    ),
  );

  it.effect("moves a task to a home at its top or bottom", () =>
    run(
      Effect.gen(function* () {
        yield* seedWeek;
        useAssistant({ tasks: "edit" });
        const top = yield* tools.reorder(ASSISTANT, {
          taskId: TaskId.make("old"),
          when: "today",
          position: "top",
        });
        expect(top.tasks.map((task) => task.id)).toEqual(["old", "run-fri"]);
        const bottom = yield* tools.reorder(ASSISTANT, {
          taskId: TaskId.make("someday"),
          when: "today",
          position: "bottom",
        });
        expect(bottom.tasks.map((task) => task.id)).toEqual(["old", "run-fri", "someday"]);
        // Already in that list: only the position changes.
        const again = yield* tools.reorder(ASSISTANT, {
          taskId: TaskId.make("someday"),
          when: "today",
          position: "top",
        });
        expect(again.tasks.map((task) => task.id)).toEqual(["someday", "old", "run-fri"]);
        const message = (params: TaskReorderInput) =>
          Effect.map(errorOf(tools.reorder(ASSISTANT, params)), (error) => error.message);
        expect(yield* message({ taskId: TaskId.make("old"), when: "today" })).toMatch(/position/);
        expect(
          yield* message({
            taskId: TaskId.make("old"),
            when: "today",
            position: "top",
            beforeTaskId: TaskId.make("run-fri"),
          }),
        ).toMatch(/without an anchor/);
      }),
    ),
  );

  it.effect("keeps a repeating task on days", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit", newTasks: "create" });
        const series = yield* tools.propose(ASSISTANT, {
          title: "Stretch",
          date: "2026-11-13",
          recurrence: { frequency: "daily", interval: 1 },
        });
        const error = yield* errorOf(
          tools.reorder(ASSISTANT, { taskId: series.task.id, when: "this-week", position: "top" }),
        );
        expect(error.message).toMatch(/only between days/);
      }),
    ),
  );
});

describe("cp_task_update completion prompt", () => {
  it.effect("answers Not yet and shows the prompt again; coordinators cannot", () =>
    run(
      Effect.gen(function* () {
        useAssistant({ tasks: "edit" });
        const dismissed = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("user-task"),
          completionPromptDismissed: true,
        });
        expect(dismissed.task.completionPromptDismissedAt).toBeDefined();
        const shown = yield* tools.update(ASSISTANT, {
          taskId: TaskId.make("user-task"),
          completionPromptDismissed: false,
        });
        expect(shown.task.completionPromptDismissedAt).toBeUndefined();
        const own = yield* tools.propose(ACME_COORD, { title: "Approve copy" });
        expect(
          (yield* errorOf(
            tools.update(ACME_COORD, { taskId: own.task.id, completionPromptDismissed: true }),
          )).message,
        ).toMatch(/completion prompt/);
      }),
    ),
  );
});
