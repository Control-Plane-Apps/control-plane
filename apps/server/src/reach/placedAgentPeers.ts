import { EventId, CommandId, MessageId, ThreadId, isStandingAgent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { RemoteAgents } from "../agentMachines/RemoteAgents.ts";
import { remotePhase, remoteReadTurns } from "../agentMachines/remoteAgentState.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { agentPeerMessageId, agentPeerFyiId } from "../orchestration/agentProtocol.ts";
import {
  AGENT_PEER_FYI_KIND,
  decidePeerBudget,
  formatPeerMessage,
  peerFyiPreview,
  peerFyiSummary,
  peerWindow,
} from "../orchestration/agentPeers.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { capAgentReadTurns } from "../mcp/toolkits/agents/agentScope.ts";
import { AgentReadInput } from "../mcp/toolkits/agents/tools.ts";
import type { AgentPeer } from "../mcp/toolkits/threads/tools.ts";
import { opFailed, type ReachRequest } from "./reachProtocol.ts";

const Caller = { threadId: Schema.String, projectId: Schema.String };
const Input = Schema.Union([
  Schema.Struct({ ...Caller, action: Schema.Literal("list") }),
  Schema.Struct({ ...Caller, action: Schema.Literal("read"), target: AgentReadInput }),
  Schema.Struct({
    ...Caller,
    action: Schema.Literal("message"),
    thread: Schema.String,
    message: Schema.String,
    notify: Schema.Boolean,
  }),
]);

const decodePeerInput = Schema.decodeUnknownEffect(Input);

export const readLocalPeer = (
  query: ProjectionSnapshotQuery["Service"],
  projectId: string,
  threadId: ThreadId,
  limit: number,
) =>
  Effect.gen(function* () {
    const detail = Option.getOrUndefined(
      yield* query.getThreadDetailSnapshot(threadId, { turnLimit: limit }),
    );
    const thread = detail?.thread;
    if (
      !thread ||
      thread.projectId !== projectId ||
      thread.archivedAt !== null ||
      thread.settledAt !== null
    ) {
      return yield* opFailed("The peer is no longer active in this Project.");
    }
    return {
      threadId,
      title: thread.title,
      phase: remotePhase({
        thread: {
          ...thread,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          latestUserMessageAt: null,
        },
        reachable: true,
        requestPending: false,
      }),
      turns: capAgentReadTurns(
        remoteReadTurns({
          messages: thread.messages,
          latestTurnState: thread.latestTurn?.state ?? null,
          limit,
        }),
      ),
    };
  });

export const makePlacedAgentPeerHost = Effect.gen(function* () {
  const agents = yield* Effect.serviceOption(RemoteAgents);
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const rows = yield* ProjectionThreadMessageRepository;
  return (request: ReachRequest) =>
    Effect.gen(function* () {
      const input = yield* decodePeerInput(request.input);
      const denied = opFailed("No active placement for this caller on this machine.");
      if (Option.isNone(agents) || input.threadId !== request.caller.threadId) return yield* denied;
      const remote = agents.value;
      const caller = Option.getOrUndefined(yield* remote.get(input.threadId));
      if (
        !caller ||
        caller.machineId !== request.caller.environmentId ||
        caller.peerProjectId !== input.projectId ||
        (caller.state !== "open" && caller.state !== "pending")
      )
        return yield* denied;
      const snapshot = yield* query.getShellSnapshot();
      const project = snapshot.projects.find((p) => p.id === caller.homeProjectId);
      if (!project?.assistant || project.assistant.archivedAt != null) return yield* denied;
      const coordinator = project.assistant.coordinatorThreadId;
      const local = snapshot.threads.filter(
        (t) => t.projectId === project.id && t.archivedAt === null && t.settledAt === null,
      );
      const linked = (yield* remote.list(project.id)).filter(
        ({ record }) =>
          record.homeProjectId === project.id &&
          record.threadId !== caller.threadId &&
          (record.state === "open" || record.state === "pending"),
      );
      if (input.action === "list") {
        const peers: AgentPeer[] = local.map((thread) => ({
          threadId: thread.id,
          title: thread.title,
          role:
            thread.id === coordinator
              ? "coordinator"
              : isStandingAgent(project, thread)
                ? "standing"
                : "agent",
          phase: remotePhase({ thread, reachable: true, requestPending: false }),
          machine: null,
        }));
        for (const { record, phase } of linked)
          peers.push({
            threadId: ThreadId.make(record.threadId),
            title: record.title,
            role: "agent",
            phase,
            machine: record.machineLabel,
          });
        return { peers };
      }
      const id = input.action === "read" ? input.target.agent : input.thread;
      const thread = local.find((t) => t.id === id);
      const record = linked.find((t) => t.record.threadId === id)?.record;
      if ((!thread && !record) || id === caller.threadId)
        return yield* opFailed("No active peer with this id in the Project.");
      if (input.action === "read") {
        const limit = input.target.turns ?? 1;
        if (record) {
          const read = yield* remote.read(record, limit);
          return {
            threadId: ThreadId.make(record.threadId),
            title: record.title,
            phase: read.phase,
            turns: capAgentReadTurns(read.turns),
          };
        }
        return yield* readLocalPeer(query, project.id, thread!.id, limit);
      }
      const text = formatPeerMessage({
        senderTitle: caller.title,
        senderThreadId: caller.threadId,
        senderIsCoordinator: false,
        message: input.message,
        resultReturns: false,
      });
      const threadId = ThreadId.make(id);
      const title = thread?.title ?? record!.title;
      const machine = record?.machineLabel ?? null;
      const messageId = agentPeerMessageId(
        threadId,
        ThreadId.make(caller.threadId),
        request.requestId,
      );
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      let queued = false;
      if (record) {
        const receipt = yield* remote.send(record, {
          text,
          sender: { id: caller.threadId, title: caller.title },
          replyTo: null,
          runtimeMode: record.runtimeMode,
          peer: true,
          receiptId: messageId,
        });
        queued = receipt.queued;
        if (receipt.duplicate)
          return { threadId, title, queued, duplicate: true, coordinatorNotified: false, machine };
      } else {
        const history = yield* rows.listByThreadId({ threadId });
        const budget = decidePeerBudget({
          window: peerWindow(
            history.map((m) => ({ ...m, senderThreadId: m.source?.threadId ?? null })),
          ),
          senderThreadId: caller.threadId,
          text,
        });
        if (budget.kind === "duplicate")
          return {
            threadId,
            title,
            queued: false,
            duplicate: true,
            coordinatorNotified: false,
            machine,
          };
        if (budget.kind !== "send")
          return yield* opFailed("Peer message budget exhausted. Ask the coordinator.");
        yield* engine.dispatch({
          type: "thread.message.user.append",
          commandId: CommandId.make(messageId),
          threadId,
          message: {
            messageId: MessageId.make(messageId),
            text,
            attachments: [],
            source: {
              kind: "agent",
              threadId: ThreadId.make(caller.threadId),
              threadTitle: caller.title,
            },
          },
          createdAt,
        });
        queued = true;
      }
      const fyi = agentPeerFyiId(messageId);
      const coordinatorNotified =
        id !== coordinator &&
        input.notify &&
        (yield* engine
          .dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(fyi),
            threadId: coordinator,
            activity: {
              id: EventId.make(fyi),
              tone: "info",
              kind: AGENT_PEER_FYI_KIND,
              summary: peerFyiSummary(caller.title, title),
              payload: {
                detail: peerFyiPreview(input.message),
                fromThreadId: caller.threadId,
                toThreadId: id,
              },
              turnId: null,
              createdAt,
            },
            createdAt,
          })
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ));
      return { threadId, title, queued, duplicate: false, coordinatorNotified, machine };
    });
});
