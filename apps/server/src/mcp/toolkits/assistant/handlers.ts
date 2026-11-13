/**
 * The `cp_assistant_*` handlers. Fork-owned.
 *
 * Only the coordinator of the global Assistant Project may call them, checked
 * live on every call. The overview reads the same shell snapshot clients get;
 * an ask is one held request per coordinator, so the existing result path
 * (`AgentCompletionReactor`) starts it when the coordinator is idle and sends
 * its final message back here.
 *
 * @module assistantHandlers
 */
import {
  ASSISTANT_ASK_ACTIVITY_KIND,
  ASSISTANT_PING_ACTIVITY_KIND,
  type AssistantPingPayload,
  assistantAskMessageText,
  assistantAskSendSlot,
  type AssistantAskActivityPayload,
  CommandId,
  EventId,
  isProjectInAssistantReach,
  MessageId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  sortProjectStatuses,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";

import { agentSendId } from "../../../orchestration/agentProtocol.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  AssistantMessagingOffError,
  AssistantOnlyError,
  AssistantToolFailedError,
  AssistantToolkit,
  type AssistantAskResult,
  type AssistantOverviewResult,
} from "./tools.ts";

/** Workspace threads the overview lists at most, newest first. */
const OVERVIEW_WORKSPACE_LIMIT = 20;

const readFailed = (cause: unknown) =>
  new AssistantToolFailedError({ detail: "Could not read your Projects.", cause });

const sendFailed = <E>(cause: Cause.Cause<E>): Effect.Effect<never, AssistantToolFailedError> =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.failCause(cause as Cause.Cause<never>)
    : Effect.fail(new AssistantToolFailedError({ detail: "Could not send the question.", cause }));

function threadPhase(thread: OrchestrationThreadShell | undefined): string {
  if (thread === undefined) return "missing";
  if (thread.hasPendingApprovals) return "waiting_for_approval";
  if (thread.hasPendingUserInput) return "waiting_for_input";
  return thread.session?.status ?? "idle";
}

/** A Project the Assistant can read and ask: live, marked, not the Assistant itself. */
function isReachableProject(project: OrchestrationProjectShell): boolean {
  const marker = project.assistant;
  return marker != null && marker.archivedAt == null && marker.scope !== "global";
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const randomUuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /** The caller, if it is the live global Assistant, with a fresh shell snapshot. */
  const requireAssistant = Effect.fn("AssistantTools.requireAssistant")(function* () {
    const invocation = yield* McpInvocationContext.requireMcpCapability("agents");
    const snapshot = yield* snapshots.getShellSnapshot().pipe(Effect.mapError(readFailed));
    const caller = snapshot.threads.find((thread) => thread.id === invocation.threadId);
    const home = caller && snapshot.projects.find((project) => project.id === caller.projectId);
    const marker = home?.assistant;
    if (
      caller === undefined ||
      marker == null ||
      marker.scope !== "global" ||
      marker.archivedAt != null ||
      marker.coordinatorThreadId !== caller.id
    ) {
      return yield* new AssistantOnlyError();
    }
    const settings = yield* settingsService.getSettings.pipe(Effect.mapError(readFailed));
    return { caller, snapshot, settings: settings.assistant };
  });

  const overview = Effect.fn("AssistantTools.overview")(function* () {
    const { snapshot, settings } = yield* requireAssistant();
    const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread] as const));
    const projects = snapshot.projects
      .filter(isReachableProject)
      .filter((project) => isProjectInAssistantReach(settings, project.id))
      .map((project) => {
        const marker = project.assistant!;
        const statuses = sortProjectStatuses(marker.statuses ?? []).filter(
          (status) => status.dismissedAt === undefined,
        );
        return {
          projectId: project.id,
          title: project.title,
          coordinatorThreadId: marker.coordinatorThreadId,
          coordinatorPhase: threadPhase(threadsById.get(marker.coordinatorThreadId)),
          needsYou: statuses.flatMap((status) =>
            status.decision !== undefined && status.decision.answeredAt === undefined
              ? [
                  {
                    statusId: status.id,
                    title: status.title,
                    question: status.decision.question,
                    recommendation: status.decision.recommendation,
                    ...(status.decision.answer !== undefined
                      ? { answer: status.decision.answer }
                      : {}),
                    ...(status.decision.deadline !== undefined
                      ? { deadline: status.decision.deadline }
                      : {}),
                  },
                ]
              : [],
          ),
          moving: statuses
            .filter((status) => status.state === "working" || status.state === "queued")
            .map((status) => ({
              statusId: status.id,
              title: status.title,
              state: status.state,
              summary: status.summary,
              updatedAt: status.updatedAt,
            })),
        };
      });
    const plainWorkspaces = new Map(
      snapshot.projects
        .filter((project) => project.assistant == null)
        .map((project) => [project.id, project.title] as const),
    );
    const workspaces =
      settings.workspaces === "read"
        ? snapshot.threads
            .filter(
              (thread) =>
                plainWorkspaces.has(thread.projectId) &&
                thread.archivedAt == null &&
                thread.settledAt == null,
            )
            .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, OVERVIEW_WORKSPACE_LIMIT)
            .map((thread) => ({
              threadId: thread.id,
              title: thread.title,
              workspace: plainWorkspaces.get(thread.projectId) ?? "",
              phase: threadPhase(thread),
              updatedAt: thread.updatedAt,
            }))
        : undefined;
    return {
      now: yield* nowIso,
      projects,
      ...(workspaces !== undefined ? { workspaces } : {}),
    } satisfies AssistantOverviewResult;
  });

  const ask = Effect.fn("AssistantTools.ask")(function* (input: {
    readonly question: string;
    readonly projectIds?: ReadonlyArray<string> | undefined;
  }) {
    const { caller, snapshot, settings } = yield* requireAssistant();
    if (!settings.messageCoordinators) return yield* new AssistantMessagingOffError();
    const reachable = snapshot.projects
      .filter(isReachableProject)
      .filter((project) => isProjectInAssistantReach(settings, project.id));
    const requested = input.projectIds === undefined ? null : new Set(input.projectIds);
    const skipped: Array<{ projectId: string; reason: string }> = [];
    if (requested !== null) {
      for (const projectId of requested) {
        if (!reachable.some((project) => project.id === projectId)) {
          skipped.push({ projectId, reason: "Not a Project in your reach." });
        }
      }
    }
    const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread] as const));
    const askId = (yield* randomUuid).replaceAll("-", "").slice(0, 12);
    const createdAt = yield* nowIso;
    const asked: Array<AssistantAskResult["asked"][number]> = [];
    for (const project of reachable) {
      if (requested !== null && !requested.has(project.id)) continue;
      const coordinatorId = project.assistant!.coordinatorThreadId;
      const coordinator = threadsById.get(coordinatorId);
      if (coordinator === undefined || coordinator.archivedAt != null) {
        skipped.push({ projectId: project.id, reason: "Its coordinator thread is gone." });
        continue;
      }
      // Held like a busy `cp_thread_send`: the result reactor starts it as soon
      // as the coordinator is idle, now or when its current turn ends.
      const id = agentSendId(coordinatorId, assistantAskSendSlot(askId, yield* randomUuid));
      yield* engine
        .dispatch({
          type: "thread.message.user.append",
          commandId: CommandId.make(id),
          threadId: coordinatorId,
          message: {
            messageId: MessageId.make(id),
            text: assistantAskMessageText(input.question),
            attachments: [],
            source: {
              kind: "agent",
              threadId: caller.id,
              threadTitle: "Assistant",
              replyTo: caller.id,
            },
          },
          createdAt,
        })
        .pipe(Effect.catchCause(sendFailed));
      const phase = threadPhase(coordinator);
      asked.push({
        projectId: project.id,
        title: project.title,
        coordinatorThreadId: coordinatorId,
        startedNow: phase !== "running" && phase !== "starting",
      });
    }
    if (asked.length > 0) {
      const payload: AssistantAskActivityPayload = {
        askId,
        question: input.question,
        targets: asked.map((target) => ({
          projectId: target.projectId,
          title: target.title,
          coordinatorThreadId: target.coordinatorThreadId,
        })),
      };
      yield* engine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`assistant-ask:${askId}`),
          threadId: caller.id,
          activity: {
            id: EventId.make(`assistant-ask:${askId}`),
            tone: "info",
            kind: ASSISTANT_ASK_ACTIVITY_KIND,
            summary: `Asked ${asked.length} ${asked.length === 1 ? "coordinator" : "coordinators"}`,
            payload,
            turnId: null,
            createdAt,
          },
          createdAt,
        })
        .pipe(Effect.catchCause(sendFailed));
    }
    return { askId, asked, skipped } satisfies AssistantAskResult;
  });

  const ping = Effect.fn("AssistantTools.ping")(function* (input: {
    readonly title: string;
    readonly body?: string | undefined;
    readonly actionLabel?: string | undefined;
    readonly actionReply?: string | undefined;
  }) {
    const { caller } = yield* requireAssistant();
    if ((input.actionLabel === undefined) !== (input.actionReply === undefined)) {
      return yield* new AssistantToolFailedError({
        detail: "Pass actionLabel and actionReply together, or neither.",
      });
    }
    const pingId = (yield* randomUuid).replaceAll("-", "").slice(0, 12);
    const createdAt = yield* nowIso;
    const body = input.body?.trim();
    const payload: AssistantPingPayload = {
      pingId,
      title: input.title,
      ...(body ? { body } : {}),
      actions:
        input.actionLabel !== undefined && input.actionReply !== undefined
          ? [{ label: input.actionLabel, reply: input.actionReply }]
          : [],
    };
    yield* engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`assistant-ping:${pingId}`),
        threadId: caller.id,
        activity: {
          id: EventId.make(`assistant-ping:${pingId}`),
          tone: "info",
          kind: ASSISTANT_PING_ACTIVITY_KIND,
          summary: input.title,
          payload,
          turnId: null,
          createdAt,
        },
        createdAt,
      })
      .pipe(Effect.catchCause(sendFailed));
    return { pingId };
  });

  return AssistantToolkit.of({
    cp_assistant_overview: () => overview(),
    cp_assistant_ask: (input) => ask(input),
    cp_assistant_ping: (input) => ping(input),
  });
});

export const AssistantToolkitHandlers = AssistantToolkit.toLayer(make);

/** Registered in `McpHttpServer.ts`; kept here so the upstream file gains one line. */
export const AssistantToolkitRegistrationLive = McpServer.toolkit(AssistantToolkit).pipe(
  Layer.provide(AssistantToolkitHandlers),
);
