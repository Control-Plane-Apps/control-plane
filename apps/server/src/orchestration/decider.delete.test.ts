import * as NodeCrypto from "node:crypto";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const seedReadModel = Effect.gen(function* () {
  const now = "2026-01-01T00:00:00.000Z";
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-delete"),
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-delete"),
      title: "Project Delete",
      workspaceRoot: "/tmp/project-delete",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });

  const withFirstThread = yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-thread-create-1"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-1"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-1"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-1"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-1"),
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 1",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });

  return yield* projectEvent(withFirstThread, {
    sequence: 3,
    eventId: asEventId("evt-thread-create-2"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-2"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-2"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-2"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-2"),
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 2",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

function normalizeDeleteEvent(event: PlannedEvent | ReadonlyArray<PlannedEvent>) {
  const events = Array.isArray(event) ? event : [event];
  return events.map((entry) => {
    switch (entry.type) {
      case "thread.deleted":
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            threadId: entry.payload.threadId,
          },
        };
      case "project.deleted":
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            projectId: entry.payload.projectId,
          },
        };
      default:
        return entry;
    }
  });
}

it.layer(NodeServices.layer)("decider deletion flows", (it) => {
  it.effect("rejects deleting a non-empty project without force", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-project-delete-no-force"),
            projectId: asProjectId("project-delete"),
          },
          readModel,
        }),
      );
      expect(error.message).toContain("cannot be deleted without force=true");
    }),
  );

  it.effect("reuses thread.delete semantics when force-deleting a non-empty project", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const projectDeleteCommand: Extract<OrchestrationCommand, { type: "project.delete" }> = {
        type: "project.delete",
        commandId: asCommandId("cmd-project-delete-force"),
        projectId: asProjectId("project-delete"),
        force: true,
      };

      const forcedResult = yield* decideOrchestrationCommand({
        command: projectDeleteCommand,
        readModel,
      });
      const forcedEvents = Array.isArray(forcedResult) ? forcedResult : [forcedResult];

      expect(forcedEvents.map((event) => event.type)).toEqual([
        "thread.deleted",
        "thread.deleted",
        "project.deleted",
      ]);

      let sequentialReadModel = readModel;
      let nextSequence = readModel.snapshotSequence;
      const sequentialEvents: PlannedEvent[] = [];
      for (const nextCommand of [
        {
          type: "thread.delete",
          commandId: projectDeleteCommand.commandId,
          threadId: asThreadId("thread-delete-1"),
        },
        {
          type: "thread.delete",
          commandId: projectDeleteCommand.commandId,
          threadId: asThreadId("thread-delete-2"),
        },
        {
          type: "project.delete",
          commandId: projectDeleteCommand.commandId,
          projectId: asProjectId("project-delete"),
        },
      ] satisfies ReadonlyArray<OrchestrationCommand>) {
        const decided = yield* decideOrchestrationCommand({
          command: nextCommand,
          readModel: sequentialReadModel,
        });
        const nextEvents = Array.isArray(decided) ? decided : [decided];
        sequentialEvents.push(...nextEvents);
        for (const nextEvent of nextEvents) {
          nextSequence += 1;
          sequentialReadModel = yield* projectEvent(sequentialReadModel, {
            ...nextEvent,
            sequence: nextSequence,
          });
        }
      }

      expect(normalizeDeleteEvent(forcedResult)).toEqual(normalizeDeleteEvent(sequentialEvents));
    }),
  );
});

it.effect(
  "archives a handoff atomically and refuses a later start or unarchive on the original",
  () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel;
      const thread = readModel.threads[0]!;
      const command = {
        type: "thread.archive" as const,
        commandId: asCommandId("fence"),
        threadId: thread.id,
        handoff: { waitId: "wait", expectedUpdatedAt: thread.updatedAt },
      };
      const result = yield* decideOrchestrationCommand({ readModel, command });
      if (!Array.isArray(result)) throw new Error("Expected companion fence event.");
      for (const event of result)
        readModel = yield* projectEvent(readModel, {
          ...event,
          sequence: readModel.snapshotSequence + 1,
        });
      for (const type of ["thread.delete", "thread.unarchive"] as const) {
        const error = yield* decideOrchestrationCommand({
          readModel,
          command: { type, threadId: thread.id, commandId: asCommandId(type) },
        }).pipe(Effect.flip);
        expect(error.message).toContain("read-only");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "creates the destination held and enforces its release after compact snapshot recovery",
  () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel;
      const thread = readModel.threads[0]!;
      const id = asThreadId("destination");
      const key = "test-activation-key";
      const hold = {
        waitId: "wait",
        machineId: "home",
        projectId: thread.projectId,
        releaseHash: NodeCrypto.createHash("sha256").update(key).digest("hex"),
      };
      const events = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.create",
          commandId: asCommandId("create-held"),
          threadId: id,
          projectId: thread.projectId,
          title: "Moved",
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          branch: null,
          worktreePath: null,
          createdAt: thread.createdAt,
          handoffHold: hold,
        },
      });
      if (!Array.isArray(events))
        throw new Error("Expected one atomic create with companion events");
      for (const event of events)
        readModel = yield* projectEvent(readModel, {
          ...event,
          sequence: readModel.snapshotSequence + 1,
        });
      const destination = readModel.threads.find((t) => t.id === id)!;
      expect(destination.archivedAt).toBeTruthy();
      const handoffActivities = destination.activities;
      expect(handoffActivities[0]?.payload).toEqual(hold);
      readModel = {
        ...readModel,
        threads: readModel.threads.map((t) => ({ ...t, activities: [] })),
      };
      const start = {
        type: "thread.turn.start" as const,
        commandId: asCommandId("direct"),
        threadId: id,
        message: {
          messageId: MessageId.make("direct"),
          role: "user" as const,
          text: "Run",
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: thread.createdAt,
      };
      const unarchive = {
        type: "thread.unarchive" as const,
        commandId: asCommandId("activate"),
        threadId: id,
      };
      for (const command of [
        start,
        unarchive,
        { ...unarchive, handoffRelease: { role: "source" as const, waitId: "wait", key } },
        {
          ...unarchive,
          handoffRelease: { role: "destination" as const, waitId: "wait", key: "wrong" },
        },
      ]) {
        expect(
          (yield* Effect.flip(
            decideOrchestrationCommand({ readModel, command, handoffActivities }),
          )).message,
        ).toContain("read-only");
      }
      const activated = yield* decideOrchestrationCommand({
        readModel,
        handoffActivities,
        command: { ...unarchive, handoffRelease: { role: "destination", waitId: "wait", key } },
      });
      if (!Array.isArray(activated)) throw new Error("Expected release receipt");
      for (const event of activated)
        readModel = yield* projectEvent(readModel, {
          ...event,
          sequence: readModel.snapshotSequence + 1,
        });
      expect(readModel.threads.find((t) => t.id === id)?.archivedAt).toBeNull();
      yield* decideOrchestrationCommand({ readModel, command: start });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a source recovery receipt rejects a delayed fence", () =>
  Effect.gen(function* () {
    let readModel = yield* seedReadModel;
    const thread = readModel.threads[0]!;
    const release = yield* decideOrchestrationCommand({
      readModel,
      command: {
        type: "thread.unarchive",
        commandId: asCommandId("recover"),
        threadId: thread.id,
        handoffRelease: { role: "source", waitId: "cancelled", key: "recover" },
      },
    });
    if (!("type" in release)) throw new Error("Active source needs only a cancellation receipt");
    readModel = yield* projectEvent(readModel, {
      ...release,
      sequence: readModel.snapshotSequence + 1,
    });
    const err = yield* Effect.flip(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.archive",
          commandId: asCommandId("delayed"),
          threadId: thread.id,
          handoff: { waitId: "cancelled", expectedUpdatedAt: thread.updatedAt },
        },
      }),
    );
    expect(err.message).toContain("cancelled");
  }).pipe(Effect.provide(NodeServices.layer)),
);
