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
  agentManagerRole,
  ASSISTANT_ASK_ACTIVITY_KIND,
  findGlobalAssistantProject,
  ProjectStatusId,
  ThreadId,
  assistantAskTitle,
  ASSISTANT_PING_ACTIVITY_KIND,
  type AssistantPingPayload,
  assistantAskMessageText,
  assistantAskSendSlot,
  type AssistantAskActivityPayload,
  CommandId,
  EventId,
  isProjectInAssistantReach,
  isStatusNeedingUser,
  MessageId,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  sortProjectStatuses,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpServer } from "effect/unstable/ai";

import { agentSendId } from "../../../orchestration/agentProtocol.ts";
import { Reach, type ReachMachine } from "../../../reach/Reach.ts";
import { ReachBridge } from "../../../reach/ReachBridge.ts";
import { assistantNoteText } from "../../../reach/reachText.ts";
import {
  AskResult as ReachAskResult,
  ThreadSendResult as ReachThreadSendResult,
} from "../../../reach/reachProtocol.ts";
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
export function isReachableProject(project: OrchestrationProjectShell): boolean {
  const marker = project.assistant;
  return marker != null && marker.archivedAt == null && marker.scope !== "global";
}

/** Every reachable Project on this server as the overview lists it; the caller applies reach. */
export function overviewProjectsOf(snapshot: OrchestrationShellSnapshot) {
  const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread] as const));
  return snapshot.projects.filter(isReachableProject).map((project) => {
    const marker = project.assistant!;
    const statuses = sortProjectStatuses(marker.statuses ?? []).filter(
      (status) => status.dismissedAt === undefined,
    );
    return {
      projectId: project.id as string,
      title: project.title,
      coordinatorThreadId: marker.coordinatorThreadId,
      coordinatorPhase: threadPhase(threadsById.get(marker.coordinatorThreadId)),
      needsYou: statuses.flatMap((status) =>
        status.decision !== undefined && isStatusNeedingUser(status)
          ? [
              {
                status,
                statusId: status.id,
                title: status.title,
                question: status.decision.question,
                recommendation: status.decision.recommendation,
                ...(status.decision.answer !== undefined ? { answer: status.decision.answer } : {}),
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
}

/** Recent live threads outside every Project, newest first. */
export function overviewWorkspacesOf(snapshot: OrchestrationShellSnapshot) {
  const plainWorkspaces = new Map(
    snapshot.projects
      .filter((project) => project.assistant == null)
      .map((project) => [project.id, project.title] as const),
  );
  return snapshot.threads
    .filter(
      (thread) =>
        plainWorkspaces.has(thread.projectId) &&
        thread.archivedAt == null &&
        thread.settledAt == null,
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, OVERVIEW_WORKSPACE_LIMIT)
    .map((thread) => ({
      threadId: thread.id as string,
      title: thread.title,
      workspace: plainWorkspaces.get(thread.projectId) ?? "",
      phase: threadPhase(thread),
      updatedAt: thread.updatedAt,
    }));
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettingsService;
  const reach = yield* Reach;
  const bridge = yield* ReachBridge;
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
      (marker.coordinatorThreadId !== caller.id && caller.pinnedAt == null)
    ) {
      return yield* new AssistantOnlyError();
    }
    const settings = yield* settingsService.getSettings.pipe(Effect.mapError(readFailed));
    return { caller, snapshot, settings: settings.assistant };
  });

  const callerRef = (caller: OrchestrationThreadShell) => ({
    threadId: caller.id as string,
    threadTitle: caller.title,
  });

  /** Each linked machine's overview, or its last known one marked stale. */
  const remoteOverviews = (caller: OrchestrationThreadShell) =>
    Effect.gen(function* () {
      const machines = yield* reach.machines;
      return yield* Effect.forEach(
        machines,
        (machine) =>
          reach.overview(machine, callerRef(caller)).pipe(
            Effect.map(({ result }) => ({
              machine,
              result,
              status: { label: machine.label, status: "online" as const },
            })),
            Effect.catch(({ error, lastKnown }) =>
              reach.healthOf(machine.id).pipe(
                Effect.map((health) => ({
                  machine,
                  result: lastKnown,
                  status: {
                    label: machine.label,
                    status:
                      error.kind === "relink"
                        ? ("needs-relink" as const)
                        : error.kind === "refused"
                          ? ("error" as const)
                          : ("offline" as const),
                    detail: error.detail,
                    ...(health.lastSeenAt !== null ? { lastSeenAt: health.lastSeenAt } : {}),
                  },
                })),
              ),
            ),
          ),
        { concurrency: 4 },
      );
    });

  const overview = Effect.fn("AssistantTools.overview")(function* () {
    const { caller, snapshot, settings } = yield* requireAssistant();
    const inReach = (projectId: string) => isProjectInAssistantReach(settings, projectId);
    const local = overviewProjectsOf(snapshot).filter((project) => inReach(project.projectId));
    const remote = yield* remoteOverviews(caller);
    const remoteProjects = remote.flatMap(({ machine, result, status }) =>
      (result?.projects ?? [])
        .filter((project) => inReach(project.projectId))
        .map((project) => ({
          ...project,
          coordinatorThreadId: ThreadId.make(project.coordinatorThreadId),
          needsYou: project.needsYou.map((question) => ({
            ...question,
            statusId: ProjectStatusId.make(question.statusId),
          })),
          moving: project.moving.map((workstream) => ({
            ...workstream,
            statusId: ProjectStatusId.make(workstream.statusId),
          })),
          machine: machine.label,
          ...(status.status === "online" ? {} : { stale: true, coordinatorPhase: status.status }),
        })),
    );
    const workspaces =
      settings.workspaces === "read"
        ? [
            ...overviewWorkspacesOf(snapshot),
            ...remote.flatMap(({ machine, result, status }) =>
              status.status === "online"
                ? (result?.workspaces ?? []).map((thread) => ({
                    ...thread,
                    machine: machine.label,
                  }))
                : [],
            ),
          ]
            .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, OVERVIEW_WORKSPACE_LIMIT)
            .map((thread) => ({ ...thread, threadId: ThreadId.make(thread.threadId) }))
        : undefined;
    return {
      now: yield* nowIso,
      projects: [...local, ...remoteProjects],
      ...(workspaces !== undefined ? { workspaces } : {}),
      ...(remote.length > 0 ? { machines: remote.map(({ status }) => status) } : {}),
    } satisfies AssistantOverviewResult;
  });

  const ask = Effect.fn("AssistantTools.ask")(function* (input: {
    readonly question: string;
    readonly title?: string | undefined;
    readonly projectIds?: ReadonlyArray<string> | undefined;
  }) {
    const { caller, snapshot, settings } = yield* requireAssistant();
    if (!settings.messageCoordinators) return yield* new AssistantMessagingOffError();
    const reachable = snapshot.projects
      .filter(isReachableProject)
      .filter((project) => isProjectInAssistantReach(settings, project.id));
    const requested = input.projectIds === undefined ? null : new Set(input.projectIds);
    const skipped: Array<{ projectId: string; reason: string }> = [];
    // Projects on linked machines: every one in reach, or the requested ones not here.
    const remoteTargets: Array<{ machine: ReachMachine; projectId: string; title: string }> = [];
    if (requested === null) {
      for (const { machine, result, status } of yield* remoteOverviews(caller)) {
        for (const project of result?.projects ?? []) {
          if (!isProjectInAssistantReach(settings, project.projectId)) continue;
          if (status.status === "online") {
            remoteTargets.push({ machine, projectId: project.projectId, title: project.title });
          } else {
            skipped.push({ projectId: project.projectId, reason: status.detail ?? "Offline." });
          }
        }
        if (status.status !== "online" && (result?.projects ?? []).length === 0) {
          skipped.push({
            projectId: `machine:${machine.label}`,
            reason: status.detail ?? `${machine.label} did not answer.`,
          });
        }
      }
    } else {
      for (const projectId of requested) {
        if (reachable.some((project) => project.id === projectId)) continue;
        if (
          !isProjectInAssistantReach(settings, projectId) ||
          snapshot.projects.some((project) => project.id === projectId)
        ) {
          skipped.push({ projectId, reason: "Not a Project in your reach." });
          continue;
        }
        const machine = yield* reach.locateProject(projectId, callerRef(caller));
        if (Option.isNone(machine)) {
          skipped.push({ projectId, reason: "Not a Project in your reach." });
          continue;
        }
        remoteTargets.push({
          machine: machine.value.machine,
          projectId,
          title: machine.value.project.title,
        });
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
    for (const target of remoteTargets) {
      const sent = yield* reach
        .call(
          target.machine,
          "ask",
          { askId, projectId: target.projectId, question: input.question },
          { threadId: caller.id, threadTitle: "Assistant" },
          ReachAskResult,
        )
        .pipe(Effect.result);
      if (sent._tag === "Failure") {
        skipped.push({ projectId: target.projectId, reason: sent.failure.detail });
        continue;
      }
      const answer = sent.success;
      yield* bridge.track({
        machineId: target.machine.id,
        machineLabel: target.machine.label,
        coordinatorThreadId: answer.coordinatorThreadId,
        coordinatorTitle: answer.title,
        messageId: answer.messageId,
        replyTo: caller.id,
        askedAt: createdAt,
      });
      asked.push({
        projectId: answer.projectId,
        title: answer.title,
        coordinatorThreadId: ThreadId.make(answer.coordinatorThreadId),
        startedNow: answer.startedNow,
        machine: target.machine.label,
      });
    }
    if (asked.length > 0) {
      const payload: AssistantAskActivityPayload = {
        askId,
        question: input.question,
        // Stored once, paths and URLs stripped, so every list shows the same short title.
        title: assistantAskTitle(input.question, input.title),
        targets: asked.map((target) => ({
          projectId: target.projectId,
          title:
            target.machine === undefined ? target.title : `${target.title} (${target.machine})`,
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

  /**
   * A coordinator's ping: a note to the user's Assistant, here or on a linked
   * machine. Only the Assistant raises a ping the user sees.
   */
  const coordinatorPing = Effect.fn("AssistantTools.coordinatorPing")(function* (input: {
    readonly title: string;
    readonly body?: string | undefined;
  }) {
    const invocation = yield* McpInvocationContext.requireMcpCapability("agents");
    const snapshot = yield* snapshots.getShellSnapshot().pipe(Effect.mapError(readFailed));
    const caller = snapshot.threads.find((thread) => thread.id === invocation.threadId);
    const home = caller && snapshot.projects.find((project) => project.id === caller.projectId);
    if (
      caller === undefined ||
      home === undefined ||
      home.assistant == null ||
      home.assistant.archivedAt != null ||
      agentManagerRole(home, caller) !== "coordinator"
    ) {
      return yield* new AssistantOnlyError();
    }
    const pingId = (yield* randomUuid).replaceAll("-", "").slice(0, 12);
    const body = input.body?.trim();
    const text = body ? `${input.title}\n\n${body}` : input.title;
    const from = `The ${home.title} coordinator`;
    const localAssistant = findGlobalAssistantProject(snapshot.projects)?.assistant;
    if (localAssistant != null) {
      const id = agentSendId(localAssistant.coordinatorThreadId, `note:${pingId}`);
      yield* engine
        .dispatch({
          type: "thread.message.user.append",
          commandId: CommandId.make(id),
          threadId: localAssistant.coordinatorThreadId,
          message: {
            messageId: MessageId.make(id),
            text: assistantNoteText({ kind: "ping", text, from }),
            attachments: [],
            source: { kind: "agent", threadId: caller.id, threadTitle: caller.title },
          },
          createdAt: yield* nowIso,
        })
        .pipe(Effect.catchCause(sendFailed));
      return { pingId, sentToAssistant: true };
    }
    const remoteAssistant = yield* reach.findAssistant;
    if (Option.isNone(remoteAssistant)) {
      const offline: Array<string> = [];
      for (const machine of yield* reach.machines) {
        const health = yield* reach.healthOf(machine.id);
        if (health.status !== "connected" && health.status !== "unknown") {
          offline.push(
            health.lastSeenAt === null
              ? `${machine.label} is offline`
              : `${machine.label} is offline, last seen ${health.lastSeenAt}`,
          );
        }
      }
      return yield* new AssistantToolFailedError({
        detail:
          offline.length > 0
            ? `The user's Assistant is not on this machine, and ${offline.join("; ")}. Nothing was sent; put it on the Status board, or try again when it is awake.`
            : "The user has no Assistant on this machine or any linked machine. Put it on the Status board instead.",
      });
    }
    const machine = {
      id: remoteAssistant.value.machineId,
      label: remoteAssistant.value.machineLabel,
    };
    yield* reach
      .call(
        machine,
        "assistant.note",
        { kind: "ping", text, projectTitle: home.title },
        { threadId: caller.id, threadTitle: caller.title },
        ReachThreadSendResult,
      )
      .pipe(Effect.mapError((error) => new AssistantToolFailedError({ detail: error.detail })));
    return { pingId, sentToAssistant: true, machine: machine.label };
  });

  const ping = Effect.fn("AssistantTools.ping")(function* (input: {
    readonly title: string;
    readonly body?: string | undefined;
    readonly actionLabel?: string | undefined;
    readonly actionReply?: string | undefined;
  }) {
    const assistant = yield* Effect.result(requireAssistant());
    if (assistant._tag === "Failure") {
      if (assistant.failure._tag !== "AssistantOnlyError") return yield* assistant.failure;
      return yield* coordinatorPing(input);
    }
    const { caller } = assistant.success;
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
