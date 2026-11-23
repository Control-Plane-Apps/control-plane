import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProjectStatus, ProjectStatusDecision, ProjectStatusId } from "./projectStatus.ts";

/** An open question together with its server-owned routing identity. */
export const AssistantNeedsYouEntry = Schema.Struct({
  environmentId: EnvironmentId,
  machineLabel: Schema.String,
  projectId: ProjectId,
  projectTitle: Schema.String,
  coordinatorThreadId: ThreadId,
  status: Schema.Struct({ ...ProjectStatus.fields, decision: ProjectStatusDecision }),
  stale: Schema.Boolean,
});
export type AssistantNeedsYouEntry = typeof AssistantNeedsYouEntry.Type;

export const AssistantNeedsYouMachine = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  state: Schema.Literals(["online", "offline", "error"]),
  detail: Schema.optional(Schema.String),
});
export type AssistantNeedsYouMachine = typeof AssistantNeedsYouMachine.Type;

export const AssistantNeedsYouResult = Schema.Struct({
  items: Schema.Array(AssistantNeedsYouEntry),
  machines: Schema.Array(AssistantNeedsYouMachine),
});
export type AssistantNeedsYouResult = typeof AssistantNeedsYouResult.Type;

export const AssistantNeedsYouReplyInput = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  coordinatorThreadId: ThreadId,
  statusId: ProjectStatusId,
  openedAt: IsoDateTime,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
});
export type AssistantNeedsYouReplyInput = typeof AssistantNeedsYouReplyInput.Type;

export const AssistantNeedsYouReplyResult = Schema.Struct({ queued: Schema.Boolean });
export type AssistantNeedsYouReplyResult = typeof AssistantNeedsYouReplyResult.Type;

export class AssistantNeedsYouError extends Schema.TaggedError<AssistantNeedsYouError>()(
  "AssistantNeedsYouError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
