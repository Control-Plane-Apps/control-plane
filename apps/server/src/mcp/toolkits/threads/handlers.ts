import {
  CommandId,
  EventId,
  MessageId,
  agentManagerRole,
  canManageAgent,
  isAssistantChannel,
  isStandingAgent,
  type OrchestrationAgentMessageSource,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { readLocalPeer } from "../../../reach/placedAgentPeers.ts";
import { AgentReadResult } from "../agents/tools.ts";
import { capAgentReadTurns } from "../agents/agentScope.ts";
import * as Option from "effect/Option";

import type { AgentPhase } from "../../../agentMachines/agentPhase.ts";
import type { RemoteAgentRecord } from "../../../agentMachines/RemoteAgentStore.ts";
import { RemoteAgents } from "../../../agentMachines/RemoteAgents.ts";
import { Reach, type ReachError, type ReachMachine } from "../../../reach/Reach.ts";
import {
  ThreadFindResult as ReachFindResult,
  ThreadSendResult as ReachSendResult,
} from "../../../reach/reachProtocol.ts";
import { AgentLineage } from "../../../orchestration/agentLineage.ts";
import {
  AGENT_PEER_FYI_KIND,
  decidePeerBudget,
  formatPeerMessage,
  peerFyiPreview,
  peerFyiSummary,
  peerWindow,
} from "../../../orchestration/agentPeers.ts";
import {
  agentDeliveryStartId,
  agentPeerFyiId,
  agentPeerMessageId,
  agentSendId,
} from "../../../orchestration/agentProtocol.ts";
import { isDeliveryIdle } from "../../../orchestration/agentPushes.ts";
import { threadHasQueuedTurnStart } from "../../../orchestration/ThreadSettlementPolicy.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadMessageRepository } from "../../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  PeerAmbiguousError,
  PeerBudgetExhaustedError,
  PeerMessagingUnavailableError,
  PeerNotFoundError,
  ThreadSendFailedError,
  ThreadSendSelfError,
  ThreadSendTargetAmbiguousError,
  ThreadSendTargetMissingError,
  ThreadSendTargetNotFoundError,
  ThreadsToolkit,
  AgentMessageResult,
  AgentPeer,
  type AgentPeerRole,
  type ThreadSendInput,
  type ThreadSendResult as ThreadSendResultShape,
} from "./tools.ts";

/** A thread in a Project with a live coordinator, and that Project. */
interface PeerScope {
  readonly sender: OrchestrationThreadShell;
  readonly project: OrchestrationProjectShell;
  readonly coordinatorId: ThreadId;
  readonly homeOnly?: boolean;
}

interface HomePeer {
  readonly kind: "home";
  readonly machine: ReachMachine;
  readonly peer: AgentPeer;
}

type PeerTarget =
  | HomePeer
  | { readonly kind: "local"; readonly thread: OrchestrationThreadShell }
  | { readonly kind: "remote"; readonly record: RemoteAgentRecord };

const isOpenRemote = (record: RemoteAgentRecord) =>
  record.state === "open" || record.state === "pending";

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const turns = yield* ProjectionTurnRepository;
  const messageRows = yield* ProjectionThreadMessageRepository;
  const lineage = yield* AgentLineage;
  const crypto = yield* Crypto.Crypto;
  const remote = yield* RemoteAgents;
  const reach = yield* Reach;

  const randomUuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const mintId = (tag: string, threadId: ThreadId) =>
    randomUuid.pipe(Effect.map((uuid) => `${tag}:${threadId}:${uuid}`));

  const resolveTarget = Effect.fn("ThreadsToolkit.resolveTarget")(function* (
    input: ThreadSendInput,
    sender: OrchestrationThreadShell,
  ) {
    if (input.threadId !== undefined) {
      const thread = yield* snapshots
        .getThreadShellById(input.threadId)
        .pipe(Effect.mapError((cause) => new ThreadSendFailedError({ cause })));
      if (Option.isNone(thread)) {
        return yield* new ThreadSendTargetNotFoundError({ query: input.threadId });
      }
      return thread.value;
    }
    const title = input.threadTitle?.trim();
    if (!title) {
      return yield* new ThreadSendTargetMissingError({});
    }
    const snapshot = yield* snapshots
      .getShellSnapshot()
      .pipe(Effect.mapError((cause) => new ThreadSendFailedError({ cause })));
    const matches = snapshot.threads.filter(
      (thread) => thread.title.localeCompare(title, undefined, { sensitivity: "accent" }) === 0,
    );
    if (matches.length === 0) {
      return yield* new ThreadSendTargetNotFoundError({ query: title });
    }
    if (matches.length === 1) return matches[0]!;
    // Agents reuse short role titles across Projects: prefer the sender's own.
    const local = matches.filter((thread) => thread.projectId === sender.projectId);
    if (local.length === 1) return local[0]!;
    return yield* new ThreadSendTargetAmbiguousError({ title });
  });

  /**
   * Inside one active Project a manager's send is a request (its result comes
   * back), and a send to a busy thread waits for its turn to end instead of
   * steering it. Null outside a Project, where sends keep their M1 behavior.
   */
  const routeInProject = Effect.fn("ThreadsToolkit.routeInProject")(function* (
    sender: OrchestrationThreadShell,
    target: OrchestrationThreadShell,
    now: string,
  ) {
    if (sender.projectId !== target.projectId) return null;
    const project = Option.getOrUndefined(yield* snapshots.getProjectShellById(sender.projectId));
    if (project?.assistant == null || project.assistant.archivedAt != null) return null;
    const role = agentManagerRole(project, sender);
    // Only a standing manager's scope depends on who created the target.
    const createdByThreadId = role === "standing" ? yield* lineage.creatorOf(target.id) : undefined;
    const replyTo =
      role !== null && canManageAgent(project, sender, { ...target, createdByThreadId })
        ? sender.id
        : undefined;
    const pendingStart = yield* turns.getPendingTurnStartByThreadId({ threadId: target.id });
    return {
      project,
      replyTo,
      idle: isDeliveryIdle(target.session, Option.getOrNull(pendingStart), now),
    };
  });

  /**
   * A send to an agent the sender started on a linked machine. Null when the
   * target is not one of those, so the local path runs. An agent the sender
   * does not manage reads as not found, as a thread in another Project would.
   */
  const sendToRemoteAgent = Effect.fn("ThreadsToolkit.sendToRemoteAgent")(function* (
    input: ThreadSendInput,
    sender: OrchestrationThreadShell,
    localMatchExists: boolean,
  ) {
    const ref = input.threadId ?? input.threadTitle?.trim();
    if (ref === undefined || ref.length === 0) return null;
    if (input.threadId === undefined && localMatchExists) return null;
    const found = yield* remote.find({ projectId: sender.projectId, ref });
    if (found.length === 0) return null;
    const project = Option.getOrUndefined(
      yield* snapshots
        .getProjectShellById(sender.projectId)
        .pipe(Effect.mapError((cause) => new ThreadSendFailedError({ cause }))),
    );
    const managed = found.filter(
      (record) =>
        project !== undefined &&
        record.homeProjectId === project.id &&
        canManageAgent(project, sender, {
          id: ThreadId.make(record.threadId),
          projectId: project.id,
          pinnedAt: null,
          createdByThreadId: ThreadId.make(record.creatorThreadId),
        }),
    );
    if (managed.length === 0) {
      // Another agent's agent: a peer message, when the sender is in the Project too.
      const peers = found.filter(
        (record) =>
          project !== undefined && record.homeProjectId === project.id && isOpenRemote(record),
      );
      const scope = project === undefined ? null : peerScopeOf(sender, project);
      if (scope === null || peers.length !== 1) {
        return yield* new ThreadSendTargetNotFoundError({ query: ref });
      }
      const sent = yield* sendPeer(
        scope,
        { kind: "remote", record: peers[0]! },
        input.message,
        true,
      );
      return { threadId: sent.threadId, threadTitle: sent.title, queued: sent.queued };
    }
    if (managed.length > 1) return yield* new ThreadSendTargetAmbiguousError({ title: ref });
    const record = managed[0]!;
    const { queued } = yield* remote
      .send(record, {
        text: input.message,
        sender: { id: sender.id, title: sender.title },
        replyTo: sender.id,
        runtimeMode: record.runtimeMode,
      })
      .pipe(Effect.mapError((cause) => new ThreadSendFailedError({ cause })));
    return { threadId: ThreadId.make(record.threadId), threadTitle: record.title, queued };
  });

  /** Null unless `sender` is the coordinator or an agent of a Project with a live coordinator. */
  function peerScopeOf(
    sender: OrchestrationThreadShell,
    project: OrchestrationProjectShell | undefined,
  ): PeerScope | null {
    const assistant = project?.assistant;
    if (project === undefined || assistant == null || assistant.archivedAt != null) return null;
    if (sender.projectId !== project.id || sender.archivedAt !== null) return null;
    return { sender, project, coordinatorId: assistant.coordinatorThreadId };
  }

  const homeCall = <A, I>(
    machine: ReachMachine,
    sender: OrchestrationThreadShell,
    input: Record<string, unknown>,
    schema: Schema.Codec<A, I>,
  ) =>
    reach.call(
      machine,
      "agent.peers",
      { ...input, threadId: sender.id, projectId: sender.projectId },
      { threadId: sender.id, threadTitle: "" },
      schema,
    );

  const homePeers = (sender: OrchestrationThreadShell) =>
    Effect.gen(function* () {
      const groups = yield* Effect.forEach(
        yield* reach.machines,
        (machine) =>
          homeCall(
            machine,
            sender,
            { action: "list" },
            Schema.Struct({ peers: Schema.Array(AgentPeer) }),
          ).pipe(
            Effect.map(({ peers }) =>
              peers.map((peer) => ({
                kind: "home" as const,
                machine,
                peer: { ...peer, machine: peer.machine ?? machine.label },
              })),
            ),
            Effect.orElseSucceed(() => []),
          ),
        { concurrency: 2 },
      );
      return groups.flat();
    });

  const requirePeerScope = Effect.fn("ThreadsToolkit.requirePeerScope")(function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    const sender = Option.getOrUndefined(
      yield* snapshots
        .getThreadShellById(invocation.threadId)
        .pipe(Effect.mapError((cause) => new ThreadSendFailedError({ cause }))),
    );
    if (sender === undefined || sender.archivedAt !== null || sender.settledAt !== null)
      return yield* new PeerMessagingUnavailableError({});
    const project = Option.getOrUndefined(
      yield* snapshots
        .getProjectShellById(sender.projectId)
        .pipe(Effect.mapError((cause) => new ThreadSendFailedError({ cause }))),
    );
    if (!project || project.assistant?.archivedAt != null)
      return yield* new PeerMessagingUnavailableError({});
    const homes = yield* homePeers(sender);
    const scope = peerScopeOf(sender, project);
    const messages = yield* messageRows
      .listByThreadId({ threadId: sender.id })
      .pipe(Effect.mapError((cause) => new ThreadSendFailedError({ cause })));
    const first = messages.find((message) => message.role === "user");
    const placed =
      first?.source?.kind === "agent" &&
      first.text.startsWith("You are running on ") &&
      first.text.includes("This machine has its own copy of the Project folder:");
    if (homes.length > 0 || placed || scope === null) {
      const coordinator = homes.find((item) => item.peer.role === "coordinator");
      if (!coordinator || homes.some((item) => item.machine.id !== coordinator.machine.id))
        return yield* new PeerMessagingUnavailableError({});
      return {
        scope: { sender, project, coordinatorId: coordinator.peer.threadId, homeOnly: true },
        homes,
        environmentId: invocation.environmentId,
      };
    }
    return { scope, homes, environmentId: invocation.environmentId };
  });

  const roleOf = (scope: PeerScope, thread: OrchestrationThreadShell): AgentPeerRole =>
    thread.id === scope.coordinatorId
      ? "coordinator"
      : isStandingAgent(scope.project, thread)
        ? "standing"
        : "agent";

  /** Threads in the Project that can take a message: not archived, not settled. */
  const activeLocalThreads = (scope: PeerScope) =>
    snapshots.getShellSnapshot().pipe(
      Effect.mapError((cause) => new ThreadSendFailedError({ cause })),
      Effect.map((snapshot) =>
        snapshot.threads.filter(
          (thread) =>
            scope.project.assistant != null &&
            thread.projectId === scope.project.id &&
            thread.archivedAt === null &&
            thread.settledAt === null,
        ),
      ),
    );

  /**
   * A threadId or exact title within the sender's Project. An id from another
   * Project reads as not found, so no Project learns of another's threads.
   */
  const resolvePeer = Effect.fn("ThreadsToolkit.resolvePeer")(function* (
    scope: PeerScope,
    to: string,
    homeTargets: ReadonlyArray<HomePeer>,
  ) {
    const ref = to.trim();
    if (scope.homeOnly) {
      const exact = homeTargets.find(({ peer }) => peer.threadId === ref);
      if (exact) return exact;
      const matches = homeTargets.filter(
        ({ peer }) => peer.title.localeCompare(ref, undefined, { sensitivity: "accent" }) === 0,
      );
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) return yield* new PeerAmbiguousError({ to: ref });
      return yield* new PeerNotFoundError({ to: ref });
    }
    const local = yield* activeLocalThreads(scope);
    const remotes = (yield* remote.find({ projectId: scope.project.id, ref })).filter(
      (record) => record.homeProjectId === scope.project.id && isOpenRemote(record),
    );
    const homes = homeTargets.filter(
      ({ peer }) =>
        !local.some((t) => t.id === peer.threadId) &&
        !remotes.some((r) => r.threadId === peer.threadId),
    );
    const homeId = homes.find((item) => item.peer.threadId === ref);
    if (homeId) return homeId;
    const byId = local.find((thread) => thread.id === ref);
    const target: PeerTarget | undefined =
      byId !== undefined
        ? { kind: "local", thread: byId }
        : remotes.find((record) => record.threadId === ref) !== undefined
          ? { kind: "remote", record: remotes.find((record) => record.threadId === ref)! }
          : undefined;
    if (target !== undefined) return target;
    const titled = [
      ...homes.filter(
        ({ peer }) => peer.title.localeCompare(ref, undefined, { sensitivity: "accent" }) === 0,
      ),
      ...local
        .filter(
          (thread) => thread.title.localeCompare(ref, undefined, { sensitivity: "accent" }) === 0,
        )
        .map((thread): PeerTarget => ({ kind: "local", thread })),
      ...remotes.map((record): PeerTarget => ({ kind: "remote", record })),
    ];
    if (titled.length === 0) return yield* new PeerNotFoundError({ to: ref });
    if (titled.length > 1) return yield* new PeerAmbiguousError({ to: ref });
    return titled[0]!;
  });

  /** The heads-up in the coordinator's thread. It never starts a turn. */
  const notifyCoordinator = (
    scope: PeerScope,
    input: {
      readonly id: string;
      readonly toId: string;
      readonly toTitle: string;
      readonly message: string;
    },
    createdAt: string,
  ) =>
    engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(agentPeerFyiId(input.id)),
        threadId: scope.coordinatorId,
        activity: {
          id: EventId.make(agentPeerFyiId(input.id)),
          tone: "info",
          kind: AGENT_PEER_FYI_KIND,
          summary: peerFyiSummary(scope.sender.title, input.toTitle),
          payload: {
            detail: peerFyiPreview(input.message),
            fromThreadId: scope.sender.id,
            toThreadId: input.toId,
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("peer message heads-up not recorded", {
                coordinatorThreadId: scope.coordinatorId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
        ),
      );

  /**
   * Sends a peer message. It is not a request (no replyTo), so no result is
   * owed; the recipient keeps its own runtime mode, so a peer cannot widen it.
   */
  const sendPeer = Effect.fn("ThreadsToolkit.sendPeer")(function* (
    scope: PeerScope,
    target: PeerTarget,
    message: string,
    notify: boolean,
  ) {
    const { sender, coordinatorId } = scope;
    if (target.kind === "home") {
      const result = yield* homeCall(
        target.machine,
        sender,
        { action: "message", thread: target.peer.threadId, message, notify },
        AgentMessageResult,
      ).pipe(
        Effect.mapError((cause) => new ThreadSendFailedError({ cause, detail: cause.detail })),
      );
      return { ...result, machine: result.machine ?? target.machine.label };
    }
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const toId = target.kind === "local" ? target.thread.id : ThreadId.make(target.record.threadId);
    if (toId === sender.id) return yield* new ThreadSendSelfError({});
    const shouldNotify = notify && sender.id !== coordinatorId && toId !== coordinatorId;
    const header = {
      senderTitle: sender.title,
      senderThreadId: sender.id,
      senderIsCoordinator: sender.id === coordinatorId,
      message,
    };

    if (target.kind === "remote") {
      const { record } = target;
      // A linked machine cannot call back into this one, so its reply comes back as a result.
      const text = formatPeerMessage({ ...header, resultReturns: true });
      const { queued } = yield* remote
        .send(record, {
          text,
          sender: { id: sender.id, title: sender.title },
          replyTo: sender.id,
          runtimeMode: record.runtimeMode,
          peer: true,
        })
        .pipe(Effect.mapError((cause) => new ThreadSendFailedError({ cause })));
      const coordinatorNotified = shouldNotify
        ? yield* notifyCoordinator(
            scope,
            {
              id: `remote:${record.threadId}:${yield* randomUuid}`,
              toId: record.threadId,
              toTitle: `${record.title} (on ${record.machineLabel})`,
              message,
            },
            createdAt,
          )
        : false;
      return {
        threadId: toId,
        title: record.title,
        queued,
        duplicate: false,
        coordinatorNotified,
        machine: record.machineLabel,
      } satisfies AgentMessageResult;
    }

    const recipient = target.thread;
    const text = formatPeerMessage({ ...header, resultReturns: false });
    const history = yield* messageRows
      .listByThreadId({ threadId: recipient.id })
      .pipe(Effect.mapError((cause) => new ThreadSendFailedError({ cause })));
    const decision = decidePeerBudget({
      window: peerWindow(
        history.map((row) => ({
          messageId: row.messageId,
          role: row.role,
          text: row.text,
          senderThreadId: row.source?.threadId ?? null,
        })),
      ),
      senderThreadId: sender.id,
      text,
    });
    const result = (queued: boolean, duplicate: boolean, coordinatorNotified: boolean) =>
      ({
        threadId: recipient.id,
        title: recipient.title,
        queued,
        duplicate,
        coordinatorNotified,
        machine: null,
      }) satisfies AgentMessageResult;
    switch (decision.kind) {
      case "duplicate":
        return result(false, true, false);
      case "pair-exhausted":
      case "recipient-exhausted":
        return yield* new PeerBudgetExhaustedError({
          to: recipient.title,
          limit: decision.limit,
          perSender: decision.kind === "pair-exhausted",
        });
      case "send":
        break;
    }
    const pendingStart = yield* turns
      .getPendingTurnStartByThreadId({ threadId: recipient.id })
      .pipe(Effect.mapError((cause) => new ThreadSendFailedError({ cause })));
    const idle = isDeliveryIdle(recipient.session, Option.getOrNull(pendingStart), createdAt);
    const id = agentPeerMessageId(recipient.id, sender.id, yield* randomUuid);
    const source: OrchestrationAgentMessageSource = {
      kind: "agent",
      threadId: sender.id,
      ...(sender.title.trim().length > 0 ? { threadTitle: sender.title } : {}),
    };
    yield* toSendFailure(
      idle
        ? engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(agentDeliveryStartId(id)),
            threadId: recipient.id,
            message: { messageId: MessageId.make(id), role: "user", text, attachments: [], source },
            runtimeMode: recipient.runtimeMode,
            interactionMode: recipient.interactionMode,
            createdAt,
          })
        : // Held: the AgentCompletionReactor starts it once the recipient is idle.
          engine.dispatch({
            type: "thread.message.user.append",
            commandId: CommandId.make(id),
            threadId: recipient.id,
            message: { messageId: MessageId.make(id), text, attachments: [], source },
            createdAt,
          }),
    );
    const coordinatorNotified = shouldNotify
      ? yield* notifyCoordinator(
          scope,
          { id, toId: recipient.id, toTitle: recipient.title, message },
          createdAt,
        )
      : false;
    return result(!idle, false, coordinatorNotified);
  });

  /** A first message no turn has adopted yet reads as starting. */
  const peerPhase = (
    scope: PeerScope,
    environmentId: McpInvocationContext.McpInvocationScope["environmentId"],
    thread: OrchestrationThreadShell,
    now: string,
  ): AgentPhase => {
    const phase = projectThreadAwareness({ environmentId, project: scope.project, thread })?.phase;
    const busy =
      phase === "starting" ||
      phase === "running" ||
      phase === "waiting_for_approval" ||
      phase === "waiting_for_input";
    if (!busy && threadHasQueuedTurnStart(thread, now)) return "starting";
    return phase ?? "idle";
  };

  /**
   * A thread on a linked machine, when none here matched. The user's Assistant
   * reaches any thread there; anyone else reaches only the user's Assistant
   * (threadTitle "Assistant" or its thread id). None when nothing matched.
   */
  const sendAcrossMachines = Effect.fn("ThreadsToolkit.sendAcrossMachines")(function* (
    input: ThreadSendInput,
    sender: OrchestrationThreadShell,
  ) {
    const ref = (input.threadId ?? input.threadTitle ?? "").trim();
    if (ref.length === 0) return Option.none<ThreadSendResultShape>();
    const callerRef = { threadId: sender.id as string, threadTitle: sender.title };
    const home = Option.getOrUndefined(
      yield* snapshots
        .getProjectShellById(sender.projectId)
        .pipe(Effect.mapError((cause) => new ThreadSendFailedError({ cause }))),
    );
    const failed = (error: ReachError) =>
      new ThreadSendFailedError({ cause: error, detail: error.detail });
    /** Nothing matched, but a machine that might have it did not answer: say so. */
    const unanswered = (machines: ReadonlyArray<ReachMachine>, what: string) =>
      Effect.gen(function* () {
        if (machines.length === 0) return Option.none<ThreadSendResultShape>();
        const details = yield* Effect.forEach(machines, (machine) =>
          reach
            .healthOf(machine.id)
            .pipe(
              Effect.map((health) =>
                health.lastSeenAt === null
                  ? `${machine.label} is offline`
                  : `${machine.label} is offline, last seen ${health.lastSeenAt}`,
              ),
            ),
        );
        return yield* new ThreadSendFailedError({
          cause: new Error("unanswered"),
          detail: `No ${what} here, and ${details.join("; ")}, so it may be there. Nothing was sent; try again when it is awake.`,
        });
      });
    const send = (machine: ReachMachine, threadId: string) =>
      reach
        .call(
          machine,
          "thread.send",
          { threadId, message: input.message },
          callerRef,
          ReachSendResult,
        )
        .pipe(
          Effect.mapError(failed),
          Effect.map((sent) =>
            Option.some<ThreadSendResultShape>({
              threadId: ThreadId.make(sent.threadId),
              threadTitle: `${sent.threadTitle} (on ${machine.label})`,
              queued: sent.queued,
            }),
          ),
        );
    if (home !== undefined && isAssistantChannel(home, sender)) {
      const known = input.threadId === undefined ? Option.none() : yield* reach.locateThread(ref);
      if (Option.isSome(known)) return yield* send(known.value, ref);
      const matches: Array<{ machine: ReachMachine; threadId: string; title: string }> = [];
      const silent: Array<ReachMachine> = [];
      for (const machine of yield* reach.machines) {
        const found = yield* reach
          .call(machine, "thread.find", { ref }, callerRef, ReachFindResult)
          .pipe(Effect.option);
        if (Option.isNone(found)) {
          silent.push(machine);
          continue;
        }
        for (const match of found.value.matches) matches.push({ machine, ...match });
      }
      if (matches.length === 0) return yield* unanswered(silent, `thread matched ${ref}`);
      if (matches.length > 1) return yield* new ThreadSendTargetAmbiguousError({ title: ref });
      return yield* send(matches[0]!.machine, matches[0]!.threadId);
    }
    const namesAssistantTitle =
      ref.localeCompare("Assistant", undefined, { sensitivity: "accent" }) === 0;
    const assistant = yield* reach.findAssistant;
    if (Option.isNone(assistant)) {
      if (!namesAssistantTitle) return Option.none<ThreadSendResultShape>();
      const silent: Array<ReachMachine> = [];
      for (const machine of yield* reach.machines) {
        const health = yield* reach.healthOf(machine.id);
        if (health.status !== "connected" && health.status !== "unknown") silent.push(machine);
      }
      return yield* unanswered(silent, "Assistant");
    }
    const namesAssistant = ref === assistant.value.threadId || namesAssistantTitle;
    if (!namesAssistant) return Option.none<ThreadSendResultShape>();
    return yield* send(
      { id: assistant.value.machineId, label: assistant.value.machineLabel },
      assistant.value.threadId,
    );
  });

  const toSendFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.fail(new ThreadSendFailedError({ cause })),
      ),
    );

  return ThreadsToolkit.of({
    cp_thread_send: (input) =>
      Effect.gen(function* () {
        const invocation = yield* McpInvocationContext.McpInvocationContext;
        const sender = yield* snapshots
          .getThreadShellById(invocation.threadId)
          .pipe(Effect.mapError((cause) => new ThreadSendFailedError({ cause })));
        if (Option.isNone(sender)) {
          return yield* new ThreadSendFailedError({
            cause: new Error("Sender thread was not found."),
          });
        }
        const localTitleMatch =
          input.threadId === undefined && input.threadTitle !== undefined
            ? (yield* snapshots
                .getShellSnapshot()
                .pipe(
                  Effect.mapError((cause) => new ThreadSendFailedError({ cause })),
                )).threads.some(
                (thread) =>
                  thread.projectId === sender.value.projectId &&
                  thread.title.localeCompare(input.threadTitle!.trim(), undefined, {
                    sensitivity: "accent",
                  }) === 0,
              )
            : false;
        const remoteSent = yield* sendToRemoteAgent(input, sender.value, localTitleMatch);
        if (remoteSent !== null) return remoteSent;
        const resolved = yield* resolveTarget(input, sender.value).pipe(
          Effect.map((thread) => ({ kind: "local" as const, thread })),
          Effect.catchTag("ThreadSendTargetNotFoundError", (notFound) =>
            sendAcrossMachines(input, sender.value).pipe(
              Effect.flatMap((sent) =>
                Option.isSome(sent)
                  ? Effect.succeed({ kind: "remote" as const, result: sent.value })
                  : Effect.fail(notFound),
              ),
            ),
          ),
        );
        if (resolved.kind === "remote") return resolved.result;
        const target: OrchestrationThreadShell = resolved.thread;
        if (target.id === sender.value.id) {
          return yield* new ThreadSendSelfError({});
        }
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const route = yield* toSendFailure(routeInProject(sender.value, target, createdAt));
        // An agent messaging an agent it does not manage: a peer message, so the
        // recipient knows who sent it and how to answer. The coordinator keeps
        // the plain path: standing agents send it their combined results.
        const scope = route === null ? null : peerScopeOf(sender.value, route.project);
        if (
          scope !== null &&
          route?.replyTo === undefined &&
          sender.value.id !== scope.coordinatorId &&
          target.id !== scope.coordinatorId
        ) {
          const sent = yield* sendPeer(
            scope,
            { kind: "local", thread: target },
            input.message,
            true,
          );
          return { threadId: sent.threadId, threadTitle: sent.title, queued: sent.queued };
        }
        const source: OrchestrationAgentMessageSource = {
          kind: "agent",
          threadId: sender.value.id,
          threadTitle: sender.value.title,
          ...(route?.replyTo !== undefined ? { replyTo: route.replyTo } : {}),
        };
        if (route !== null && !route.idle) {
          // Held: the AgentCompletionReactor starts it once the target is idle.
          const id = agentSendId(target.id, yield* randomUuid);
          yield* toSendFailure(
            engine.dispatch({
              type: "thread.message.user.append",
              commandId: CommandId.make(id),
              threadId: target.id,
              message: {
                messageId: MessageId.make(id),
                text: input.message,
                attachments: [],
                source,
              },
              createdAt,
            }),
          );
          return { threadId: target.id, threadTitle: target.title, queued: true };
        }
        yield* toSendFailure(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(yield* mintId("mcp-thread-send", target.id)),
            threadId: target.id,
            message: {
              messageId: MessageId.make(yield* mintId("agent-message", target.id)),
              role: "user",
              text: input.message,
              attachments: [],
              source,
            },
            runtimeMode: target.runtimeMode,
            interactionMode: target.interactionMode,
            createdAt,
          }),
        );
        return { threadId: target.id, threadTitle: target.title, queued: false };
      }),

    cp_agent_message: (input) =>
      Effect.gen(function* () {
        const { scope, homes } = yield* requirePeerScope();
        // Agents used to cp_thread_send pass threadId; take it as `to`.
        const to = input.to ?? input.threadId;
        if (to === undefined) return yield* new ThreadSendTargetMissingError({});
        const target = yield* resolvePeer(scope, to, homes);
        return yield* sendPeer(scope, target, input.message, input.notifyCoordinator !== false);
      }),

    cp_agent_peer_read: (input) =>
      Effect.gen(function* () {
        const { scope, homes } = yield* requirePeerScope();
        const target = yield* resolvePeer(scope, input.agent, homes);
        const fail = (cause: unknown) => new ThreadSendFailedError({ cause });
        const limit = input.turns ?? 1;
        if (target.kind === "home")
          return yield* homeCall(
            target.machine,
            scope.sender,
            { action: "read", target: { agent: target.peer.threadId, turns: limit } },
            AgentReadResult,
          ).pipe(Effect.mapError(fail));
        if (target.kind === "local")
          return yield* readLocalPeer(snapshots, scope.project.id, target.thread.id, limit).pipe(
            Effect.mapError(fail),
          );
        const read = yield* remote.read(target.record, limit).pipe(Effect.mapError(fail));
        return {
          threadId: ThreadId.make(target.record.threadId),
          title: target.record.title,
          phase: read.phase,
          turns: capAgentReadTurns(read.turns),
        };
      }),

    cp_agent_peers: () =>
      Effect.gen(function* () {
        const { scope, homes, environmentId } = yield* requirePeerScope();
        const now = DateTime.formatIso(yield* DateTime.now);
        if (scope.homeOnly)
          return {
            self: { threadId: scope.sender.id, title: scope.sender.title, role: "agent" as const },
            peers: homes.map(({ peer }) => peer),
          };
        const local = (yield* activeLocalThreads(scope))
          .filter((thread) => thread.id !== scope.sender.id)
          .map((thread): AgentPeer => ({
            threadId: thread.id,
            title: thread.title,
            role: roleOf(scope, thread),
            phase: peerPhase(scope, environmentId, thread, now),
            machine: null,
          }));
        const onMachines = (yield* remote.list(scope.project.id))
          .filter(({ record }) => isOpenRemote(record) && record.threadId !== scope.sender.id)
          .map(({ record, phase }): AgentPeer => ({
            threadId: ThreadId.make(record.threadId),
            title: record.title,
            role: "agent",
            phase,
            machine: record.machineLabel,
          }));
        return {
          self: {
            threadId: scope.sender.id,
            title: scope.sender.title,
            role: roleOf(scope, scope.sender),
          },
          peers: [
            ...local,
            ...onMachines,
            ...homes
              .map((item) => item.peer)
              .filter(
                (peer) => ![...local, ...onMachines].some((t) => t.threadId === peer.threadId),
              ),
          ],
        };
      }),
  });
});

/** Needs `AgentLineage` and the turn and message repositories; tests provide stubs. */
export const ThreadsToolkitHandlers = ThreadsToolkit.toLayer(make);

export const ThreadsToolkitHandlersLive = ThreadsToolkitHandlers.pipe(
  Layer.provide(
    Layer.mergeAll(
      AgentLineage.layer,
      ProjectionTurnRepositoryLive,
      ProjectionThreadMessageRepositoryLive,
    ),
  ),
);
