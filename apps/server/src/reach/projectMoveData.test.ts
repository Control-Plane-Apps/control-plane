import { expect, it } from "@effect/vitest";
import {
  EventId,
  OrchestrationProposedPlanId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationProjectionPipeline } from "../orchestration/Services/ProjectionPipeline.ts";

import { AgentLineage } from "../orchestration/agentLineage.ts";
import { makeRecord } from "../agentMachines/testFixtures.ts";
import { RemoteAgentStore, RemoteAgentStoreLive } from "../agentMachines/RemoteAgentStore.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ServerConfig } from "../config.ts";
import {
  makeScheduleEngineLayer,
  makeScheduleFixture,
} from "../schedules/schedules.testFixtures.ts";
import { acquireProjectMoveFence, releaseProjectMoveFence } from "./projectMoveFence.ts";
import { makeProjectMoveData } from "./projectMoveData.ts";

it.effect(
  "round trips a fenced Project through separate SQLite environments and verifies destination writes before cleanup",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const setup = (name: string) =>
          Layer.build(
            Layer.mergeAll(
              ProjectionProjectRepositoryLive,
              RemoteAgentStoreLive,
              AgentLineage.layer,
            ).pipe(Layer.provideMerge(makeScheduleEngineLayer("project-move-" + name))),
          );
        const source = yield* setup("source");
        const target = yield* setup("destination");
        const original = ProjectId.make("synthetic-origin");
        const destination = ProjectId.make("synthetic-target");
        const coordinator = ThreadId.make("synthetic-manager");
        const agent = ThreadId.make("synthetic-worker");
        const moveId = "synthetic-transfer";
        const create = (id: ProjectId) =>
          Effect.gen(function* () {
            const fixture = yield* makeScheduleFixture;
            const config = yield* ServerConfig;
            const fs = yield* FileSystem.FileSystem;
            const root = config.stateDir + "/checkout";
            yield* fs.makeDirectory(root, { recursive: true });
            yield* fixture.dispatch({
              type: "project.create",
              projectId: id,
              commandId: CommandId.make("init"),
              title: "Synthetic",
              workspaceRoot: root,
              createdAt: yield* fixture.now,
            });
            return {
              fixture,
              root,
              fs,
              config,
              lineage: yield* AgentLineage,
              data: yield* makeProjectMoveData,
            };
          });
        const src = yield* Effect.provide(create(original), source);
        const dst = yield* Effect.provide(create(destination), target);
        const backup = yield* dst.data.capture(destination);
        yield* src.fixture.createThread(original, coordinator, "Coordinator");
        yield* src.fixture.dispatch({
          type: "project.meta.update",
          projectId: original,
          commandId: CommandId.make("marker"),
          assistant: { coordinatorThreadId: coordinator },
        });
        yield* src.fixture.dispatch({
          type: "thread.create",
          commandId: CommandId.make("spawn"),
          projectId: original,
          threadId: agent,
          title: "Worker",
          createdByThreadId: coordinator,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: yield* src.fixture.now,
        });
        yield* src.fixture.dispatch({
          type: "thread.pin",
          commandId: CommandId.make("pin"),
          threadId: agent,
        });
        yield* src.fixture.setSchedules(original, [
          { id: "daily", cron: "0 9 * * *", target: agent },
        ]);
        const stamp = yield* src.fixture.now;
        yield* src.fixture.dispatch({
          type: "project.schedule.record",
          createdAt: stamp,
          projectId: original,
          scheduleId: "daily",
          commandId: CommandId.make(`cp-schedule-run:${original}:daily:${stamp}`),
          run: { slot: stamp, at: stamp, trigger: "cron", outcome: "sent", threadId: agent },
        });
        yield* src.fixture.dispatch({
          type: "project.status.set",
          actorThreadId: coordinator,
          projectId: original,
          commandId: CommandId.make("status"),
          createdAt: stamp,
          change: {
            kind: "upsert",
            id: "tests",
            title: "Tests",
            state: "queued",
            summary: "Awaiting review",
            agents: [agent],
          },
        });
        const append = (id: string, text: string) => ({
          type: "thread.message.user.append" as const,
          commandId: CommandId.make(id),
          threadId: coordinator,
          createdAt: stamp,
          message: { messageId: MessageId.make(id), text, attachments: [] },
        });
        const message = append("source-msg", "Move this history");
        const attachment = {
          type: "file" as const,
          id: "synthetic-manager-785d58f4-3fa3-4f41-8e25-6f383aade103-txt",
          name: "evidence.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
        };
        yield* src.fs.makeDirectory(src.config.attachmentsDir, { recursive: true });
        yield* src.fs.writeFileString(
          src.config.attachmentsDir + "/" + attachment.id + ".txt",
          "proof",
        );
        yield* dst.fs.makeDirectory(dst.config.attachmentsDir, { recursive: true });
        yield* src.fixture.dispatch({
          ...message,
          message: { ...message.message, attachments: [attachment] },
        });
        yield* src.fs.writeFileString(src.root + "/MEMORY.md", "Source memory\n");
        yield* Effect.provide(acquireProjectMoveFence(original, moveId), source);
        yield* Effect.provide(acquireProjectMoveFence(destination, "aborted-staging"), target);
        const bundle = yield* src.data.capture(original);
        expect(bundle.project.assistant?.scheduleRuns?.daily?.slot).toBe(stamp);
        expect(src.config.attachmentsDir).not.toBe(dst.config.attachmentsDir);
        const targetFile = dst.config.attachmentsDir + "/" + attachment.id + ".txt";
        expect(yield* dst.fs.exists(targetFile)).toBe(false);
        // Simulate refusal after the attachment lands but before projections commit.
        const refused = yield* Effect.result(
          dst.data.install(destination, "aborted-staging", {
            ...bundle,
            receipts: [...bundle.receipts, ...bundle.receipts],
          }),
        );
        expect(refused._tag).toBe("Failure");
        const staging = (yield* dst.fs.readDirectory(dst.config.attachmentsDir)).filter((name) =>
          name.startsWith(".cp-project-move-"),
        );
        expect(staging).toHaveLength(1);
        expect(yield* dst.fs.readDirectory(dst.config.attachmentsDir + "/" + staging[0])).toEqual([
          attachment.id + ".txt",
        ]);
        expect(yield* dst.fs.readFileString(targetFile)).toBe("proof");
        yield* dst.data.install(destination, "aborted-staging", backup, dst.data.digest(backup));
        expect(yield* dst.fs.exists(targetFile)).toBe(false);
        yield* Effect.provide(releaseProjectMoveFence(destination, "aborted-staging"), target);
        yield* Effect.provide(acquireProjectMoveFence(destination, moveId), target);
        yield* dst.data.install(destination, moveId, bundle, undefined, true);
        yield* dst.data.install(destination, moveId, bundle, undefined, true);
        expect(dst.data.digest(yield* dst.data.capture(destination))).toBe(src.data.digest(bundle));
        expect(yield* dst.lineage.creatorOf(agent)).toBe(coordinator);
        expect(
          yield* dst.fs.readFileString(dst.config.attachmentsDir + "/" + attachment.id + ".txt"),
        ).toBe("proof");
        yield* Effect.provide(releaseProjectMoveFence(destination, moveId), target);
        const response = append("new-message", "Destination wrote after activation");
        const responseFile = {
          ...attachment,
          id: "synthetic-manager-785d58f4-3fa3-4f41-8e25-6f383aade104-txt",
        };
        yield* dst.fs.writeFileString(
          dst.config.attachmentsDir + "/" + responseFile.id + ".txt",
          "reply",
        );
        yield* dst.fixture.dispatch({
          ...response,
          message: {
            ...response.message,
            attachments: [responseFile],
            source: { kind: "agent", threadId: agent, threadTitle: "Worker" },
          },
        });
        yield* dst.fixture.dispatch({
          type: "thread.proposed-plan.upsert",
          commandId: CommandId.make("new-plan"),
          threadId: coordinator,
          createdAt: stamp,
          proposedPlan: {
            id: OrchestrationProposedPlanId.make("return-plan"),
            turnId: null,
            planMarkdown: "Test plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: stamp,
            updatedAt: stamp,
          },
        });
        yield* dst.fixture.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("new-activity"),
          threadId: coordinator,
          createdAt: stamp,
          activity: {
            id: EventId.make("return-activity"),
            tone: "info",
            kind: "synthetic",
            summary: "Test",
            turnId: null,
            payload: { requestId: "return-request" },
            createdAt: stamp,
          },
        });
        const temporary = ThreadId.make("synthetic-removed-agent");
        yield* dst.fixture.dispatch({
          type: "thread.create",
          commandId: CommandId.make("destination-create-temporary"),
          threadId: temporary,
          projectId: destination,
          title: "Temporary",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: stamp,
        });
        yield* dst.fixture.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("remove-agent"),
          threadId: temporary,
        });
        yield* dst.fs.writeFileString(dst.root + "/MEMORY.md", "Destination memory\n");
        yield* Effect.provide(acquireProjectMoveFence(destination, moveId), target);
        const back = yield* dst.data.capture(destination);
        const receivedPath = src.config.attachmentsDir + "/" + responseFile.id + ".txt";
        yield* src.fs.writeFileString(receivedPath, "wrong");
        expect((yield* Effect.result(src.data.verifyReturn(original, moveId, back)))._tag).toBe(
          "Failure",
        );
        expect(yield* src.fs.readFileString(receivedPath)).toBe("wrong");
        expect(src.data.digest(yield* src.data.capture(original))).toBe(src.data.digest(bundle));
        yield* src.fs.remove(receivedPath);
        // A single transfer can carry conflicting ownership even on an otherwise empty source.
        const from = back.threads.find((t) => t.id === coordinator)!;
        const other = back.threads.find((t) => t.id === agent)!;
        for (const event of from.events) {
          if (
            event.type !== "thread.proposed-plan-upserted" &&
            event.type !== "thread.activity-appended"
          )
            continue;
          const conflicting =
            event.type === "thread.proposed-plan-upserted"
              ? { ...event, aggregateId: agent, payload: { ...event.payload, threadId: agent } }
              : { ...event, aggregateId: agent, payload: { ...event.payload, threadId: agent } };
          const invalid = {
            ...back,
            threads: back.threads.map((t) =>
              t.id === agent ? { ...other, events: [...other.events, conflicting] } : t,
            ),
          };
          expect(
            (yield* Effect.result(src.data.verifyReturn(original, moveId, invalid)))._tag,
          ).toBe("Failure");
        }
        const sql = yield* Effect.provide(SqlClient.SqlClient, source);
        // Exercise the exact projection keys used by ordinary upserts, including approval IDs
        // that are independent of the activity ID itself.
        const outsider = ThreadId.make("unrelated-owner");
        for (const [insert, remove] of [
          [
            sql`INSERT INTO projection_thread_proposed_plans(plan_id,thread_id,plan_markdown,created_at,updated_at) VALUES ('return-plan',${outsider},'Other',${stamp},${stamp})`,
            sql`DELETE FROM projection_thread_proposed_plans WHERE plan_id='return-plan'`,
          ],
          [
            sql`INSERT INTO projection_thread_activities(activity_id,thread_id,tone,kind,summary,payload_json,created_at) VALUES ('return-activity',${outsider},'info','synthetic','Other','{}',${stamp})`,
            sql`DELETE FROM projection_thread_activities WHERE activity_id='return-activity'`,
          ],
          [
            sql`INSERT INTO projection_pending_approvals(request_id,thread_id,status,created_at) VALUES ('return-request',${outsider},'resolved',${stamp})`,
            sql`DELETE FROM projection_pending_approvals WHERE request_id='return-request'`,
          ],
        ] as const) {
          yield* insert;
          expect((yield* Effect.result(src.data.verifyReturn(original, moveId, back)))._tag).toBe(
            "Failure",
          );
          yield* remove;
        }
        // The file-registry check occurs after the cross-Project SQL reservation.
        // A local refusal must release every claim before the destination is contacted.
        const registry = yield* Effect.provide(RemoteAgentStore, source);
        yield* registry.put(
          makeRecord({ threadId: temporary, homeProjectId: "unrelated-registry-owner" }),
        );
        expect((yield* Effect.result(src.data.verifyReturn(original, moveId, back)))._tag).toBe(
          "Failure",
        );
        expect(
          yield* sql`SELECT identity FROM project_move_history_claims WHERE project_id=${original}`,
        ).toHaveLength(0);
        yield* registry.remove(temporary);
        yield* src.data.verifyReturn(original, moveId, back);
        expect(yield* src.fs.exists(receivedPath)).toBe(false);
        yield* src.data.install(original, moveId, back);
        expect(yield* src.fs.readFileString(receivedPath)).toBe("reply");
        expect(src.data.digest(yield* src.data.capture(original))).toBe(dst.data.digest(back));
        expect(yield* src.fs.readFileString(src.root + "/MEMORY.md")).toBe("Destination memory\n");
        yield* dst.data.install(destination, moveId, backup, dst.data.digest(back));
        expect(yield* dst.fs.exists(targetFile)).toBe(false);
        expect(dst.data.digest(yield* dst.data.capture(destination))).toBe(dst.data.digest(backup));
        yield* Effect.provide(releaseProjectMoveFence(destination, moveId), target);
        yield* Effect.provide(acquireProjectMoveFence(destination, "second-move"), target);
        // This matching file belongs to the destination independently of the
        // second move. Neither staging nor rollback may claim or remove it.
        yield* dst.fs.writeFileString(targetFile, "proof");
        yield* dst.data.install(destination, "second-move", back, undefined, true);
        expect(dst.data.digest(yield* dst.data.capture(destination))).toBe(dst.data.digest(back));
        yield* dst.data.install(destination, "second-move", backup, dst.data.digest(back));
        expect(yield* dst.fs.readFileString(targetFile)).toBe("proof");
        yield* Effect.provide(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DELETE FROM projection_state WHERE projector='projection.attachment-cleanup'`;
            const pipeline = yield* OrchestrationProjectionPipeline;
            yield* pipeline.bootstrap;
          }),
          target,
        );
        expect(yield* dst.fs.readFileString(targetFile)).toBe("proof");
      }),
    ),
);
