import {
  ASSISTANT_PING_BODY_MAX,
  ASSISTANT_PING_LABEL_MAX,
  ASSISTANT_PING_REPLY_MAX,
  ASSISTANT_PING_TITLE_MAX,
  McpCapabilityUnavailableError,
  ProjectStatusId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

// Fork-owned. The cross-Project Assistant's tools. Only the coordinator of the
// global Assistant Project can call them. Parameters stay flat primitives:
// OpenCode stringifies nested unions.

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

/** Longest question `cp_assistant_ask` sends. */
export const ASSISTANT_ASK_QUESTION_MAX = 2_000;

export class AssistantOnlyError extends Schema.TaggedError<AssistantOnlyError>()(
  "AssistantOnlyError",
  {},
) {
  override get message(): string {
    return "Only the Assistant can use the cp_assistant_* tools.";
  }
}

export class AssistantMessagingOffError extends Schema.TaggedError<AssistantMessagingOffError>()(
  "AssistantMessagingOffError",
  {},
) {
  override get message(): string {
    return "The user turned off messaging Project coordinators in Settings, Assistant.";
  }
}

export class AssistantToolFailedError extends Schema.TaggedError<AssistantToolFailedError>()(
  "AssistantToolFailedError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

export const AssistantToolError = Schema.Union([
  McpCapabilityUnavailableError,
  AssistantOnlyError,
  AssistantMessagingOffError,
  AssistantToolFailedError,
]);

export const AssistantOverviewQuestion = Schema.Struct({
  statusId: ProjectStatusId,
  title: Schema.String,
  question: Schema.String,
  recommendation: Schema.String,
  answer: Schema.optional(Schema.String),
  deadline: Schema.optional(Schema.String),
});

export const AssistantOverviewWorkstream = Schema.Struct({
  statusId: ProjectStatusId,
  title: Schema.String,
  state: Schema.String,
  summary: Schema.String,
  updatedAt: Schema.String,
});

export const AssistantOverviewProject = Schema.Struct({
  projectId: Schema.String,
  title: Schema.String,
  coordinatorThreadId: ThreadId,
  coordinatorPhase: Schema.String,
  needsYou: Schema.Array(AssistantOverviewQuestion),
  moving: Schema.Array(AssistantOverviewWorkstream),
});

export const AssistantOverviewWorkspaceThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  workspace: Schema.String,
  phase: Schema.String,
  updatedAt: Schema.String,
});

export const AssistantOverviewResult = Schema.Struct({
  now: Schema.String,
  projects: Schema.Array(AssistantOverviewProject),
  /** Absent when the user keeps workspaces out of the Assistant's reach. */
  workspaces: Schema.optional(Schema.Array(AssistantOverviewWorkspaceThread)),
});
export type AssistantOverviewResult = typeof AssistantOverviewResult.Type;

export const AssistantAskInput = Schema.Struct({
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSISTANT_ASK_QUESTION_MAX)).annotate({
    description: "What to ask. Each coordinator receives it as written.",
  }),
  projectIds: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Project ids from cp_assistant_overview. Omit to ask every Project in your reach.",
  }),
});
export type AssistantAskInput = typeof AssistantAskInput.Type;

export const AssistantAskTarget = Schema.Struct({
  projectId: Schema.String,
  title: Schema.String,
  coordinatorThreadId: ThreadId,
  /** False when the coordinator is busy: it gets the question when its turn ends. */
  startedNow: Schema.Boolean,
});

export const AssistantAskSkipped = Schema.Struct({
  projectId: Schema.String,
  reason: Schema.String,
});

export const AssistantAskResult = Schema.Struct({
  askId: Schema.String,
  asked: Schema.Array(AssistantAskTarget),
  skipped: Schema.Array(AssistantAskSkipped),
});
export type AssistantAskResult = typeof AssistantAskResult.Type;

export const AssistantPingInput = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSISTANT_PING_TITLE_MAX)).annotate({
    description:
      "One line the user reads first, such as 'Claude Code weekly limit runs out Thursday'.",
  }),
  body: Schema.optional(
    Schema.String.check(Schema.isMaxLength(ASSISTANT_PING_BODY_MAX)).annotate({
      description: "One or two sentences, ending with the question if there is one.",
    }),
  ),
  actionLabel: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(ASSISTANT_PING_LABEL_MAX)).annotate({
      description: "Button for the one action you recommend, such as 'Pause them'.",
    }),
  ),
  actionReply: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(ASSISTANT_PING_REPLY_MAX)).annotate({
      description:
        "The message sent to you as the user's when they tap it. Required with actionLabel.",
    }),
  ),
});
export type AssistantPingInput = typeof AssistantPingInput.Type;

export const AssistantPingResult = Schema.Struct({ pingId: Schema.String });

const AssistantPingTool = Tool.make("cp_assistant_ping", {
  description:
    "Assistant only. Raise a heads-up the user sees as a notification, with at most one recommended one-tap reply (Not now is always offered and sends nothing). Use it sparingly: only for something time-sensitive the user would want to hear about now.",
  parameters: AssistantPingInput,
  success: AssistantPingResult,
  failure: AssistantToolError,
  dependencies,
})
  .annotate(Tool.Title, "Ping the user")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const AssistantOverviewTool = Tool.make("cp_assistant_overview", {
  description:
    "Assistant only. What needs the user and what is moving across every Project in reach: each Project's open Status questions with recommendations, its working and queued workstreams, and recent workspace threads when allowed.",
  success: AssistantOverviewResult,
  failure: AssistantToolError,
  dependencies,
})
  .annotate(Tool.Title, "Overview across Projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AssistantAskTool = Tool.make("cp_assistant_ask", {
  description:
    "Assistant only. Ask Project coordinators a question at once. Returns immediately; each coordinator's answer arrives later as a message from it. Do not poll.",
  parameters: AssistantAskInput,
  success: AssistantAskResult,
  failure: AssistantToolError,
  dependencies,
})
  .annotate(Tool.Title, "Ask Project coordinators")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const AssistantToolkit = Toolkit.make(
  AssistantOverviewTool,
  AssistantAskTool,
  AssistantPingTool,
);
