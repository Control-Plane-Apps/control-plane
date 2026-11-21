/**
 * The wire format of `POST /api/reach`, the one route servers call on each
 * other for the user's Assistant. Both ends run this build. Fork-owned; see
 * docs/internals/assistant-cross-server-reach.md.
 *
 * @module reachProtocol
 */
import * as Schema from "effect/Schema";

export { REACH_ROUTE_PATH } from "../agentMachines/AgentMachineClient.ts";

/** Who on the calling server makes the call. A claim made by a holder of an operate token. */
export const ReachCaller = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  threadId: Schema.String,
  threadTitle: Schema.String,
});
export type ReachCaller = typeof ReachCaller.Type;

export const ReachOp = Schema.Literals([
  "describe",
  "overview",
  "ask",
  "results",
  "status.list",
  "status.set",
  "thread.find",
  "thread.send",
  "assistant.note",
  "task.deliver",
  "schedule.list",
  "schedule.create",
  "schedule.update",
  "schedule.delete",
]);
export type ReachOp = typeof ReachOp.Type;

export const ReachRequest = Schema.Struct({
  op: ReachOp,
  /** Unique per call; the callee builds its command ids from it, so a retry dedupes. */
  requestId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{6,64}$/)),
  caller: ReachCaller,
  input: Schema.Unknown,
});
export type ReachRequest = typeof ReachRequest.Type;

export const ReachResponse = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
export type ReachResponse = typeof ReachResponse.Type;

// ── Op inputs and results ─────────────────────────────────────────

export const DescribeResult = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  /** The live global Assistant here, or null. */
  assistant: Schema.NullOr(Schema.Struct({ threadId: Schema.String, projectId: Schema.String })),
});
export type DescribeResult = typeof DescribeResult.Type;

export const AskInput = Schema.Struct({
  askId: Schema.String,
  projectId: Schema.String,
  question: Schema.String,
});
export const AskResult = Schema.Struct({
  projectId: Schema.String,
  title: Schema.String,
  coordinatorThreadId: Schema.String,
  /** The request's message id there; with the coordinator id it names the answer. */
  messageId: Schema.String,
  startedNow: Schema.Boolean,
});
export type AskResult = typeof AskResult.Type;

export const ResultsInput = Schema.Struct({
  requests: Schema.Array(Schema.Struct({ threadId: Schema.String, messageId: Schema.String })),
});
export const ResultsResult = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      messageId: Schema.String,
      threadTitle: Schema.String,
      text: Schema.String,
    }),
  ),
  /** Requests whose thread is gone there: no answer will come. */
  lost: Schema.Array(Schema.Struct({ threadId: Schema.String, messageId: Schema.String })),
});
export type ResultsResult = typeof ResultsResult.Type;

export const ProjectInput = Schema.Struct({ projectId: Schema.String });

export const ProjectToolInput = Schema.Struct({
  projectId: Schema.String,
  input: Schema.Unknown,
  /** Schedules: the Assistant's turn was started by the user's own message. */
  userTurn: Schema.optional(Schema.Boolean),
});

export const ThreadFindInput = Schema.Struct({ ref: Schema.String });
export const ThreadFindResult = Schema.Struct({
  matches: Schema.Array(Schema.Struct({ threadId: Schema.String, title: Schema.String })),
});

export const ThreadSendInput = Schema.Struct({
  threadId: Schema.String,
  message: Schema.String,
});
export const ThreadSendResult = Schema.Struct({
  threadId: Schema.String,
  threadTitle: Schema.String,
  queued: Schema.Boolean,
});
export type ThreadSendResult = typeof ThreadSendResult.Type;

export const AssistantNoteInput = Schema.Struct({
  kind: Schema.Literals(["message", "ping"]),
  text: Schema.String,
  projectTitle: Schema.NullOr(Schema.String),
});

export const TaskDeliverInput = Schema.Struct({
  threadId: Schema.String,
  text: Schema.String,
});

/** One Project the callee's coordinators run, as the Assistant's overview lists it. */
export const OverviewProject = Schema.Struct({
  projectId: Schema.String,
  title: Schema.String,
  coordinatorThreadId: Schema.String,
  coordinatorPhase: Schema.String,
  needsYou: Schema.Array(
    Schema.Struct({
      statusId: Schema.String,
      title: Schema.String,
      question: Schema.String,
      recommendation: Schema.String,
      answer: Schema.optional(Schema.String),
      deadline: Schema.optional(Schema.String),
    }),
  ),
  moving: Schema.Array(
    Schema.Struct({
      statusId: Schema.String,
      title: Schema.String,
      state: Schema.String,
      summary: Schema.String,
      updatedAt: Schema.String,
    }),
  ),
});
export type OverviewProject = typeof OverviewProject.Type;

export const OverviewWorkspaceThread = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  workspace: Schema.String,
  phase: Schema.String,
  updatedAt: Schema.String,
});

/** Every live, marked, non-global Project there, and recent workspace threads. Unfiltered: the Assistant's server applies its reach. */
export const OverviewResult = Schema.Struct({
  projects: Schema.Array(OverviewProject),
  workspaces: Schema.Array(OverviewWorkspaceThread),
});
export type OverviewResult = typeof OverviewResult.Type;
