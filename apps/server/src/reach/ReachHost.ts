/**
 * The called side of cross-server reach: runs one op from a linked server
 * against this server's own Projects, coordinators and Assistant. Ops act
 * only here and never call another server, so a call cannot loop. Every
 * message they leave is a held `cp-send:` append, which the
 * AgentCompletionReactor starts once its thread is idle. Fork-owned; see
 * docs/internals/assistant-cross-server-reach.md.
 *
 * @module ReachHost
 */
import {
  assistantAskMessageText,
  assistantAskSendSlot,
  CommandId,
  findGlobalAssistantProject,
  MessageId,
  REACH_RESULT_ACTIVITY_KIND,
  reachSendSlot,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type ReachRemoteActor,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { agentPushId, agentSendId } from "../orchestration/agentProtocol.ts";
import { isDeliveryIdle } from "../orchestration/agentPushes.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import {
  isReachableProject,
  overviewProjectsOf,
  overviewWorkspacesOf,
} from "../mcp/toolkits/assistant/handlers.ts";
import { makeScheduleCore, type ScheduleScope } from "../mcp/toolkits/agents/scheduleHandlers.ts";
import { makeStatusCore } from "../mcp/toolkits/agents/statusHandlers.ts";
import {
  ScheduleCreateInput,
  ScheduleDeleteInput,
  ScheduleTurnOnNotRequestedError,
  ScheduleUpdateInput,
  StatusSetInput,
} from "../mcp/toolkits/agents/tools.ts";
import { assistantNoteText, remoteSenderTitle } from "./reachText.ts";
import {
  AskInput,
  AssistantNoteInput,
  ProjectInput,
  ProjectToolInput,
  ResultsInput,
  TaskDeliverInput,
  ThreadFindInput,
  ThreadSendInput,
  type AskResult,
  type DescribeResult,
  type OverviewResult,
  type ReachCaller,
  type ReachRequest,
  type ReachResponse,
  type ResultsResult,
  type ThreadSendResult,
} from "./reachProtocol.ts";

export interface ReachHostShape {
  readonly handle: (request: ReachRequest) => Effect.Effect<ReachResponse>;
}

class ReachOpError extends Schema.TaggedError<ReachOpError>()("ReachOpError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const opFailed = (detail: string) => new ReachOpError({ detail });

const ResultActivityRow = Schema.Struct({
  activityId: Schema.String,
  payload: Schema.fromJsonString(Schema.Struct({ text: Schema.String })),
});
const decodeResultActivityRow = Schema.decodeOption(ResultActivityRow);

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const turns = yield* ProjectionTurnRepository;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const sql = yield* SqlClient.SqlClient;
  const statusCore = yield* makeStatusCore;
  const settings = yield* ServerSettingsService;
  const scheduleCore = yield* makeScheduleCore;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const shell = snapshots
    .getShellSnapshot()
    .pipe(Effect.mapError(() => opFailed("Could not read this machine's Projects.")));

  const decode =
    <A, I>(schema: Schema.Codec<A, I>) =>
    (input: unknown) =>
      Schema.decodeUnknownEffect(schema)(input).pipe(
        Effect.mapError(() => opFailed("The request was not understood. Update both machines.")),
      );

  const remoteActorOf = (caller: ReachCaller): ReachRemoteActor => ({
    environmentId: caller.environmentId,
    label: caller.label,
    threadId: ThreadId.make(caller.threadId),
  });

  /** A live, marked, non-global Project here, or an error naming it. */
  const requireProject = (snapshot: OrchestrationShellSnapshot, projectId: string) => {
    const project = snapshot.projects.find((entry) => entry.id === projectId);
    return project !== undefined && isReachableProject(project)
      ? Effect.succeed(
          project as OrchestrationProjectShell & {
            assistant: NonNullable<OrchestrationProjectShell["assistant"]>;
          },
        )
      : Effect.fail(opFailed(`'${projectId}' is not a Project on this machine.`));
  };

  /** Appends a held message; the reactor starts it now if the thread is idle. */
  const hold = (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly text: string;
    readonly caller: ReachCaller;
    readonly replyTo?: string;
  }) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const thread = Option.getOrUndefined(
        yield* snapshots
          .getThreadShellById(input.threadId)
          .pipe(Effect.mapError(() => opFailed("Could not read the thread."))),
      );
      if (thread === undefined || thread.archivedAt != null) {
        return yield* opFailed(`There is no live thread '${input.threadId}' on this machine.`);
      }
      const pending = yield* turns
        .getPendingTurnStartByThreadId({ threadId: thread.id })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const idle = isDeliveryIdle(thread.session, Option.getOrNull(pending), createdAt);
      yield* engine
        .dispatch({
          type: "thread.message.user.append",
          commandId: CommandId.make(input.messageId),
          threadId: thread.id,
          message: {
            messageId: MessageId.make(input.messageId),
            text: input.text,
            attachments: [],
            source: {
              kind: "agent",
              threadId: ThreadId.make(input.caller.threadId),
              threadTitle: remoteSenderTitle(input.caller),
              ...(input.replyTo !== undefined ? { replyTo: ThreadId.make(input.replyTo) } : {}),
            },
          },
          createdAt,
        })
        .pipe(Effect.mapError((error) => opFailed(`Not sent: ${String(error.message ?? error)}`)));
      return {
        threadId: thread.id as string,
        threadTitle: thread.title,
        queued: !idle,
      } satisfies ThreadSendResult;
    });

  const describe = Effect.gen(function* () {
    const descriptor = yield* environment.getDescriptor;
    const snapshot = yield* shell;
    const assistant = findGlobalAssistantProject(snapshot.projects);
    return {
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      assistant:
        assistant?.assistant == null
          ? null
          : { threadId: assistant.assistant.coordinatorThreadId, projectId: assistant.id },
    } satisfies DescribeResult;
  });

  const overview = Effect.gen(function* () {
    const snapshot = yield* shell;
    return {
      projects: overviewProjectsOf(snapshot),
      workspaces: overviewWorkspacesOf(snapshot),
    } satisfies OverviewResult;
  });

  const ask = (request: ReachRequest) =>
    Effect.gen(function* () {
      const input = yield* decode(AskInput)(request.input);
      const snapshot = yield* shell;
      const project = yield* requireProject(snapshot, input.projectId);
      const coordinatorId = project.assistant.coordinatorThreadId;
      const coordinator = snapshot.threads.find((thread) => thread.id === coordinatorId);
      if (coordinator === undefined || coordinator.archivedAt != null) {
        return yield* opFailed("Its coordinator thread is gone.");
      }
      // `ask:<askId>:` lets the Assistant's ask card match the answer;
      // `reach:` makes the reactor keep the answer for the asking server.
      const messageId = agentSendId(
        coordinatorId,
        assistantAskSendSlot(input.askId, reachSendSlot(request.requestId)),
      );
      const sent = yield* hold({
        threadId: coordinatorId,
        messageId,
        text: assistantAskMessageText(input.question),
        caller: request.caller,
        replyTo: request.caller.threadId,
      });
      return {
        projectId: project.id,
        title: project.title,
        coordinatorThreadId: coordinatorId,
        messageId,
        startedNow: !sent.queued,
      } satisfies AskResult;
    });

  const results = (request: ReachRequest) =>
    Effect.gen(function* () {
      const input = yield* decode(ResultsInput)(request.input);
      if (input.requests.length === 0) return { results: [], lost: [] } satisfies ResultsResult;
      const ids = input.requests.map((entry) => agentPushId(entry.threadId, entry.messageId));
      const rows = yield* sql<{ activityId: string; payload: string }>`
        SELECT activity_id AS "activityId", payload_json AS "payload"
        FROM projection_thread_activities
        WHERE kind = ${REACH_RESULT_ACTIVITY_KIND} AND ${sql.in("activity_id", ids)}
      `.pipe(Effect.mapError(() => opFailed("Could not read the answers.")));
      const decoded = new Map<string, string>();
      for (const row of rows) {
        const parsed = decodeResultActivityRow(row);
        if (Option.isSome(parsed)) decoded.set(parsed.value.activityId, parsed.value.payload.text);
      }
      const snapshot = yield* shell;
      const out: Array<ResultsResult["results"][number]> = [];
      const lost: Array<ResultsResult["lost"][number]> = [];
      for (const entry of input.requests) {
        const text = decoded.get(agentPushId(entry.threadId, entry.messageId));
        const thread = snapshot.threads.find((candidate) => candidate.id === entry.threadId);
        if (text !== undefined) {
          out.push({ ...entry, threadTitle: thread?.title ?? "Coordinator", text });
        } else if (thread === undefined) {
          lost.push(entry);
        }
      }
      return { results: out, lost } satisfies ResultsResult;
    });

  const statusList = (request: ReachRequest) =>
    Effect.gen(function* () {
      const input = yield* decode(ProjectInput)(request.input);
      const project = yield* requireProject(yield* shell, input.projectId);
      return yield* statusCore.list(project.id);
    });

  const statusSet = (request: ReachRequest) =>
    Effect.gen(function* () {
      const input = yield* decode(
        Schema.Struct({ projectId: Schema.String, input: StatusSetInput, note: Schema.Boolean }),
      )(request.input);
      const project = yield* requireProject(yield* shell, input.projectId);
      return yield* statusCore.set(
        {
          actorThreadId: ThreadId.make(request.caller.threadId),
          projectId: project.id,
          note: input.note
            ? {
                coordinatorThreadId: project.assistant.coordinatorThreadId,
                assistantTitle: remoteSenderTitle({ ...request.caller, threadTitle: "Assistant" }),
              }
            : null,
          remoteActor: remoteActorOf(request.caller),
        },
        { ...input.input, projectId: undefined },
        `reach:${request.requestId}`,
      );
    });

  const threadFind = (request: ReachRequest) =>
    Effect.gen(function* () {
      const input = yield* decode(ThreadFindInput)(request.input);
      const snapshot = yield* shell;
      const ref = input.ref.trim();
      const live = snapshot.threads.filter(
        (thread) => thread.archivedAt == null && thread.settledAt == null,
      );
      const byId = snapshot.threads.filter(
        (thread) => thread.id === ref && thread.archivedAt == null,
      );
      if (byId.length > 0) {
        return { matches: byId.map((thread) => ({ threadId: thread.id, title: thread.title })) };
      }
      // "Assistant" names the user's Assistant here, whatever its thread is titled.
      if (ref.localeCompare("Assistant", undefined, { sensitivity: "accent" }) === 0) {
        const assistant = findGlobalAssistantProject(snapshot.projects)?.assistant;
        const thread =
          assistant == null
            ? undefined
            : snapshot.threads.find((entry) => entry.id === assistant.coordinatorThreadId);
        if (thread !== undefined) {
          return { matches: [{ threadId: thread.id, title: thread.title }] };
        }
      }
      return {
        matches: live
          .filter(
            (thread) => thread.title.localeCompare(ref, undefined, { sensitivity: "accent" }) === 0,
          )
          .map((thread) => ({ threadId: thread.id, title: thread.title })),
      };
    });

  const threadSend = (request: ReachRequest) =>
    Effect.gen(function* () {
      const input = yield* decode(ThreadSendInput)(request.input);
      const threadId = ThreadId.make(input.threadId);
      return yield* hold({
        threadId,
        messageId: agentSendId(threadId, `remote:${request.requestId}`),
        text: input.message,
        caller: request.caller,
      });
    });

  const assistantNote = (request: ReachRequest) =>
    Effect.gen(function* () {
      const input = yield* decode(AssistantNoteInput)(request.input);
      const assistant = findGlobalAssistantProject((yield* shell).projects)?.assistant;
      if (assistant == null) return yield* opFailed("This machine has no Assistant.");
      const from =
        input.projectTitle === null
          ? remoteSenderTitle(request.caller)
          : `The ${input.projectTitle} coordinator (on ${request.caller.label})`;
      return yield* hold({
        threadId: assistant.coordinatorThreadId,
        messageId: agentSendId(assistant.coordinatorThreadId, `remote:${request.requestId}`),
        text: assistantNoteText({ kind: input.kind, text: input.text, from }),
        caller: request.caller,
      });
    });

  const taskDeliver = (request: ReachRequest) =>
    Effect.gen(function* () {
      const input = yield* decode(TaskDeliverInput)(request.input);
      const threadId = ThreadId.make(input.threadId);
      return yield* hold({
        threadId,
        messageId: agentSendId(threadId, `task-handoff:remote:${request.requestId}`),
        text: `${input.text}\n\nThese tasks are on the user's task list on ${request.caller.label}; with Task Sync on they are on this machine's list too. When you are done, tell the Assistant with cp_thread_send (threadTitle "Assistant").`,
        caller: request.caller,
      });
    });

  /** The Assistant on the calling server acts on a Project here. */
  const scheduleScope = (request: ReachRequest) =>
    Effect.gen(function* () {
      const input = yield* decode(ProjectToolInput)(request.input);
      const project = yield* requireProject(yield* shell, input.projectId);
      const scope: ScheduleScope = {
        project,
        actorThreadId: ThreadId.make(request.caller.threadId),
        remoteActor: remoteActorOf(request.caller),
        // The calling server checked the Assistant's own turn and says so here.
        requireUserTurn:
          input.userTurn === true
            ? Effect.void
            : Effect.fail(new ScheduleTurnOnNotRequestedError()),
      };
      return { scope, input: input.input };
    });

  const run = (request: ReachRequest): Effect.Effect<unknown, Error> => {
    switch (request.op) {
      case "describe":
        return describe;
      case "overview":
        return overview;
      case "ask":
        return ask(request);
      case "results":
        return results(request);
      case "status.list":
        return statusList(request);
      case "status.set":
        return statusSet(request);
      case "thread.find":
        return threadFind(request);
      case "thread.send":
        return threadSend(request);
      case "assistant.note":
        return assistantNote(request);
      case "task.deliver":
        return taskDeliver(request);
      case "schedule.list":
        return scheduleScope(request).pipe(Effect.flatMap(({ scope }) => scheduleCore.list(scope)));
      case "schedule.create":
        return scheduleScope(request).pipe(
          Effect.flatMap(({ scope, input }) =>
            decode(ScheduleCreateInput)(input).pipe(
              Effect.flatMap((parsed) => scheduleCore.create(scope, parsed)),
            ),
          ),
        );
      case "schedule.update":
        return scheduleScope(request).pipe(
          Effect.flatMap(({ scope, input }) =>
            decode(ScheduleUpdateInput)(input).pipe(
              Effect.flatMap((parsed) => scheduleCore.update(scope, parsed)),
            ),
          ),
        );
      case "schedule.delete":
        return scheduleScope(request).pipe(
          Effect.flatMap(({ scope, input }) =>
            decode(ScheduleDeleteInput)(input).pipe(
              Effect.flatMap((parsed) => scheduleCore.delete(scope, parsed)),
            ),
          ),
        );
    }
  };

  const handle = (request: ReachRequest): Effect.Effect<ReachResponse> =>
    Effect.gen(function* () {
      const self = yield* environment.getEnvironmentId;
      if (request.caller.environmentId === self) {
        return { ok: false as const, error: "A machine cannot reach itself." };
      }
      // A machine this one linked is called what the user named it here.
      const linkedLabel = yield* settings.getSettings.pipe(
        Effect.map(
          (current) => current.agentPlacement.machines[request.caller.environmentId]?.label,
        ),
        Effect.orElseSucceed(() => undefined),
      );
      const named =
        linkedLabel === undefined
          ? request
          : { ...request, caller: { ...request.caller, label: linkedLabel } };
      return yield* run(named).pipe(
        Effect.map((result) => ({ ok: true as const, result })),
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            error:
              error.message.length > 0
                ? error.message
                : "The operation failed on the linked machine.",
          }),
        ),
        Effect.catchDefect((defect) =>
          Effect.logWarning("reach op failed", { op: request.op, defect: String(defect) }).pipe(
            Effect.as({ ok: false as const, error: "The operation failed on the linked machine." }),
          ),
        ),
      );
    });

  return { handle } satisfies ReachHostShape;
});

/** The repositories the host reads, which the server's layer does not expose. */
export const ReachHostDependencies = Layer.mergeAll(
  ProjectionTurnRepositoryLive,
  ProjectionThreadMessageRepositoryLive,
  ProjectionProjectRepositoryLive,
);
