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
  "confirm",
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
  "assistant.adopt",
  "assistant.commit",
  "assistant.abort",
  "assistant.moveStatus",
  "assistant.handoff",
  "assistant.yield",
  "link.back",
  "authority.poke",
  "assistant.history",
  "assistant.attachment",
  "assistant.verify",
  "assistant.legacy.list",
  "assistant.legacy.page",
  "assistant.legacy.attachment",
  "assistant.legacy.remove",
]);
export type ReachOp = typeof ReachOp.Type;

/** Largest body the route reads at all. */
export const REACH_MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Most ops carry a message or a status row. */
const DEFAULT_BODY_LIMIT = 256 * 1024;
/** Ops that carry more, by op. */
const BODY_LIMITS: Partial<Record<string, number>> = {
  // Up to 200 messages and the memory file.
  "assistant.adopt": REACH_MAX_BODY_BYTES,
  // A page of the Assistant's conversation, and one attachment chunk (base64).
  "assistant.history": 16 * 1024 * 1024,
  "assistant.attachment": 12 * 1024 * 1024,
};

/** The largest body accepted for one op. */
export function reachBodyLimit(op: string): number {
  return BODY_LIMITS[op] ?? DEFAULT_BODY_LIMIT;
}

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
  /** Environment ids of the machines it has linked; absent from older builds. */
  linked: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Its tasks, for task authority: its Task Sync account key when synced
   * (a hash, never the address) else null, whether it rolls commitments now,
   * and its rollover setting with when it was chosen. Absent from older builds.
   */
  tasks: Schema.optional(
    Schema.Struct({
      account: Schema.NullOr(Schema.String),
      rolls: Schema.Boolean,
      rollover: Schema.Struct({ enabled: Schema.Boolean, setAt: Schema.NullOr(Schema.String) }),
    }),
  ),
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

/** The callee asks the claimed caller whether it really sent a request. */
export const ConfirmInput = Schema.Struct({
  requestId: Schema.String,
  op: Schema.String,
  inputHash: Schema.String,
  /** The machine asking, which must be the one the request was sent to. */
  receiver: Schema.String,
});
export const ConfirmResult = Schema.Struct({ sent: Schema.Boolean });

/**
 * Ops that act for the caller. The callee runs them only after the caller,
 * reached over the callee's own pinned link, confirms it sent the request.
 */
export const REACH_VERIFIED_OPS: ReadonlySet<string> = new Set([
  "ask",
  "status.set",
  "thread.send",
  "assistant.note",
  "task.deliver",
  "schedule.create",
  "schedule.update",
  "schedule.delete",
  "assistant.adopt",
  "assistant.commit",
  "assistant.abort",
  "assistant.handoff",
  "assistant.yield",
  "assistant.history",
  "assistant.attachment",
  "assistant.verify",
  // An older copy's conversation and files: only for the Assistant's machine, confirmed.
  "assistant.legacy.list",
  "assistant.legacy.page",
  "assistant.legacy.attachment",
  "assistant.legacy.remove",
]);

/** Everything that moves with the Assistant. */
export const AssistantBundle = Schema.Struct({
  moveId: Schema.String,
  /** `ServerSettings.assistant` on the old home, encoded. */
  settings: Schema.Unknown,
  schedules: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      cron: Schema.String,
      enabled: Schema.Boolean,
      prompt: Schema.String,
    }),
  ),
  memory: Schema.NullOr(Schema.String),
  /** The first page of the conversation; the rest follows as `assistant.history` pages. */
  messages: Schema.Array(
    Schema.Struct({
      /** Kept on the new machine, so a resent page never duplicates. Absent from older builds. */
      messageId: Schema.optional(Schema.String),
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      createdAt: Schema.String,
      attachments: Schema.optional(Schema.Array(Schema.Unknown)),
    }),
  ),
  /**
   * The whole conversation the target must hold before the move may commit.
   * Absent from older builds (they moved only the last 200 messages).
   */
  history: Schema.optional(
    Schema.Struct({ count: Schema.Number, digest: Schema.String, attachments: Schema.Number }),
  ),
  /** Open asks of coordinators, which the new home keeps polling for. */
  asks: Schema.Array(
    Schema.Struct({
      machineId: Schema.String,
      machineLabel: Schema.String,
      coordinatorThreadId: Schema.String,
      coordinatorTitle: Schema.String,
      messageId: Schema.String,
      askedAt: Schema.String,
    }),
  ),
  modelSelection: Schema.Unknown,
  runtimeMode: Schema.String,
});
export type AssistantBundle = typeof AssistantBundle.Type;

export const AdoptResult = Schema.Struct({ projectId: Schema.String, threadId: Schema.String });
export type AdoptResult = typeof AdoptResult.Type;

export const HandoffInput = Schema.Struct({ to: Schema.String });

export const LinkBackInput = Schema.Struct({ pairingUrl: Schema.String });
export const LinkBackResult = Schema.Struct({ id: Schema.String, label: Schema.String });

export const MoveIdInput = Schema.Struct({ moveId: Schema.String });

/** One message of the Assistant's conversation as it moves. Attachments are encoded `ChatAttachment`s. */
export const HistoryMessage = Schema.Struct({
  messageId: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  createdAt: Schema.String,
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type HistoryMessage = typeof HistoryMessage.Type;

/** A page of the conversation after the adopt (the adopt carries the first). */
export const HistoryPageInput = Schema.Struct({
  moveId: Schema.String,
  page: Schema.Number,
  messages: Schema.Array(HistoryMessage),
});

/** One chunk of one attachment file, in order. The last chunk carries the whole file's hash. */
export const AttachmentChunkInput = Schema.Struct({
  moveId: Schema.String,
  /** The attachment as the source stores it (encoded `ChatAttachment`). */
  attachment: Schema.Unknown,
  offset: Schema.Number,
  totalBytes: Schema.Number,
  sha256: Schema.String,
  data: Schema.String,
});
export const AttachmentChunkResult = Schema.Struct({ received: Schema.Number });

/** Older Assistant copies an earlier build left here (archived, not retired). */
export const LegacyListResult = Schema.Struct({
  copies: Schema.Array(
    Schema.Struct({
      projectId: Schema.String,
      count: Schema.Number,
      digest: Schema.String,
      pages: Schema.Number,
    }),
  ),
});
export const LegacyPageInput = Schema.Struct({ projectId: Schema.String, page: Schema.Number });
export const LegacyPageResult = Schema.Struct({ messages: Schema.Array(HistoryMessage) });
export const LegacyAttachmentInput = Schema.Struct({
  projectId: Schema.String,
  attachment: Schema.Unknown,
  offset: Schema.Number,
});
export const LegacyAttachmentResult = Schema.Struct({
  data: Schema.String,
  totalBytes: Schema.Number,
  sha256: Schema.String,
});
/** Removes an older copy; refused unless its conversation still has this digest. */
export const LegacyRemoveInput = Schema.Struct({
  projectId: Schema.String,
  count: Schema.Number,
  digest: Schema.String,
});
export const LegacyRemoveResult = Schema.Struct({ removed: Schema.Boolean });

/** What the target must hold before commit: message count and a digest of the conversation. */
export const HistoryVerifyInput = Schema.Struct({
  moveId: Schema.String,
  count: Schema.Number,
  digest: Schema.String,
  attachments: Schema.Number,
});
export const HistoryVerifyResult = Schema.Struct({
  ok: Schema.Boolean,
  count: Schema.Number,
  digest: Schema.String,
  attachments: Schema.Number,
});
export const YieldResult = Schema.Struct({ paused: Schema.Boolean });
export const MoveStatusResult = Schema.Struct({
  phase: Schema.Literals(["adopted", "committed", "aborted", "unknown"]),
});
