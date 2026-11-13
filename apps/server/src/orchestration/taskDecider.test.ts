import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  TaskId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type Task,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-11-13T12:00:00.000Z";
const LATER = "2026-11-13T13:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const COORDINATOR_ID = ThreadId.make("coordinator");
const AGENT_ID = ThreadId.make("agent-1");

function thread(id: ThreadId): OrchestrationThread {
  return {
    id,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

const project = {
  id: PROJECT_ID,
  title: "Hometrace",
  workspaceRoot: "/tmp/hometrace",
  defaultModelSelection: null,
  assistant: {
    coordinatorThreadId: COORDINATOR_ID,
    statuses: [
      {
        id: "payments",
        title: "Payments retry",
        state: "working",
        summary: "Retries wired.",
        updatedAt: NOW,
      },
    ],
  },
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
} as unknown as OrchestrationProject;

const baseModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [project],
  threads: [thread(COORDINATOR_ID), thread(AGENT_ID)],
  updatedAt: NOW,
};

let counter = 0;
const cmd = <T extends OrchestrationCommand>(
  command: Omit<T, "commandId" | "createdAt"> & { createdAt?: string },
) =>
  ({
    commandId: CommandId.make(`cmd-${(counter += 1)}`),
    createdAt: NOW,
    ...command,
  }) as unknown as T;

const run = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.gen(function* () {
    const decided = yield* decideOrchestrationCommand({ command, readModel });
    let next = readModel;
    for (const event of Array.isArray(decided) ? decided : [decided]) {
      next = yield* projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 });
    }
    return next;
  });

const create = (taskId: string, extra: Record<string, unknown> = {}) =>
  cmd({
    type: "task.create",
    taskId: TaskId.make(taskId),
    title: "Ship payments retry",
    home: { kind: "date", date: "2026-11-13" },
    ...extra,
  } as never);

it.layer(NodeServices.layer)("tasks", (it) => {
  it.effect("creates a task and fills a thread link's Project", () =>
    Effect.gen(function* () {
      const model = yield* run(baseModel, create("t1", { links: { threadId: AGENT_ID } }));
      expect(model.tasks).toHaveLength(1);
      expect(model.tasks?.[0]).toMatchObject({
        id: "t1",
        status: "todo",
        links: { projectId: PROJECT_ID, threadId: AGENT_ID },
      });
    }),
  );

  it.effect("refuses a workstream link the Project does not have", () =>
    Effect.gen(function* () {
      const error = yield* run(
        baseModel,
        create("t1", { links: { projectId: PROJECT_ID, statusId: "nope" } }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("completing a repeating task closes it and opens the next occurrence", () =>
    Effect.gen(function* () {
      let model = yield* run(
        baseModel,
        create("weekly", {
          title: "Weekly planning",
          home: { kind: "date", date: "2026-11-16", reminderTime: "09:00" },
          recurrence: { frequency: "weekly", interval: 1 },
        }),
      );
      model = yield* run(
        model,
        cmd({
          type: "task.update",
          taskId: TaskId.make("weekly"),
          patch: { status: "completed" },
          createdAt: LATER,
        } as never),
      );
      const [closed, next] = model.tasks as Task[];
      expect(closed).toMatchObject({ id: "weekly", status: "completed", completedAt: LATER });
      expect(closed!.recurrence).toBeUndefined();
      expect(next).toMatchObject({
        status: "todo",
        title: "Weekly planning",
        home: { kind: "date", date: "2026-11-23", reminderTime: "09:00" },
        recurrence: { frequency: "weekly", interval: 1 },
      });
    }),
  );

  it.effect("only a task on a day can repeat", () =>
    Effect.gen(function* () {
      const error = yield* run(
        baseModel,
        create("t1", {
          home: { kind: "backlog", horizon: null },
          recurrence: { frequency: "daily", interval: 1 },
        }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("only the coordinator proposes, and only the user accepts or dismisses", () =>
    Effect.gen(function* () {
      const propose = (actor: ThreadId, taskId: string, title = "Confirm Stripe email copy") =>
        cmd({
          type: "task.propose",
          taskId: TaskId.make(taskId),
          projectId: PROJECT_ID,
          actorThreadId: actor,
          title,
          home: { kind: "date", date: "2026-11-13" },
          statusId: "payments",
        } as never);
      const refused = yield* run(baseModel, propose(AGENT_ID, "p0")).pipe(Effect.flip);
      expect(refused._tag).toBe("OrchestrationCommandInvariantError");

      let model = yield* run(baseModel, propose(COORDINATOR_ID, "p1"));
      expect(model.tasks?.[0]).toMatchObject({
        proposal: { projectId: PROJECT_ID, threadId: COORDINATOR_ID },
        links: { projectId: PROJECT_ID, statusId: "payments" },
      });
      const duplicate = yield* run(model, propose(COORDINATOR_ID, "p2")).pipe(Effect.flip);
      expect(duplicate._tag).toBe("OrchestrationCommandInvariantError");

      // A proposal cannot be edited until it is added.
      const early = yield* run(
        model,
        cmd({ type: "task.update", taskId: TaskId.make("p1"), patch: { title: "x" } } as never),
      ).pipe(Effect.flip);
      expect(early._tag).toBe("OrchestrationCommandInvariantError");

      model = yield* run(
        model,
        cmd({
          type: "task.proposal.respond",
          taskId: TaskId.make("p1"),
          accept: true,
          createdAt: LATER,
        } as never),
      );
      expect(model.tasks?.[0]?.proposal?.acceptedAt).toBe(LATER);

      model = yield* run(model, propose(COORDINATOR_ID, "p3", "Pick 3 vendors"));
      model = yield* run(
        model,
        cmd({ type: "task.proposal.respond", taskId: TaskId.make("p3"), accept: false } as never),
      );
      expect(model.tasks?.map((task) => task.id)).toEqual(["p1"]);
    }),
  );

  it.effect("handing off links the task to the thread; Not yet stamps the prompt", () =>
    Effect.gen(function* () {
      let model = yield* run(baseModel, create("t1"));
      model = yield* run(
        model,
        cmd({
          type: "task.handoff",
          taskId: TaskId.make("t1"),
          handoff: { kind: "coordinator", threadId: COORDINATOR_ID, at: NOW },
        } as never),
      );
      expect(model.tasks?.[0]).toMatchObject({
        links: { projectId: PROJECT_ID, threadId: COORDINATOR_ID },
        handoff: { kind: "coordinator", threadId: COORDINATOR_ID },
      });
      model = yield* run(
        model,
        cmd({
          type: "task.update",
          taskId: TaskId.make("t1"),
          patch: { completionPromptDismissedAt: LATER },
        } as never),
      );
      expect(model.tasks?.[0]?.completionPromptDismissedAt).toBe(LATER);
    }),
  );

  it.effect("sets and clears a period intent", () =>
    Effect.gen(function* () {
      let model = yield* run(
        baseModel,
        cmd({
          type: "task.intent.set",
          horizon: "week",
          startsOn: "2026-11-09",
          text: " Ship payments and the PDF export. ",
        } as never),
      );
      expect(model.taskIntents).toEqual([
        {
          horizon: "week",
          startsOn: "2026-11-09",
          text: "Ship payments and the PDF export.",
          updatedAt: NOW,
        },
      ]);
      model = yield* run(
        model,
        cmd({
          type: "task.intent.set",
          horizon: "week",
          startsOn: "2026-11-09",
          text: "",
        } as never),
      );
      expect(model.taskIntents).toEqual([]);
    }),
  );

  it.effect("refuses a second import of the same Lucive task", () =>
    Effect.gen(function* () {
      const source = { importSource: { kind: "lucive", id: "sync-1" } };
      const model = yield* run(baseModel, create("t1", source));
      const error = yield* run(model, create("t2", source)).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
