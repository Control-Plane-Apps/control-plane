import * as Schema from "effect/Schema";
import {
  ChatAttachment,
  HistoricalOrchestrationEvent,
  ProjectMetaUpdatedPayload,
} from "./orchestration.ts";
import { ThreadId } from "./baseSchemas.ts";

/** Identifiers inside histories remain stable across environments. */
export const ProjectMoveBundle = Schema.Struct({
  version: Schema.Literal(1),
  coordinator: Schema.NullOr(ThreadId),
  project: ProjectMetaUpdatedPayload,
  zone: Schema.String,
  threads: Schema.Array(
    Schema.Struct({
      id: ThreadId,
      events: Schema.Array(HistoricalOrchestrationEvent),
      /** Hash of the independently read durable projection, including the latest turn. */
      projectionDigest: Schema.String,
    }),
  ),
  receipts: Schema.Array(
    Schema.Struct({
      commandId: Schema.String,
      aggregateKind: Schema.Literals(["project", "thread"]),
      aggregateId: Schema.String,
      acceptedAt: Schema.String,
      status: Schema.Literals(["accepted", "rejected"]),
      error: Schema.NullOr(Schema.String),
    }),
  ),
  memory: Schema.NullOr(Schema.String),
  roles: Schema.Record(Schema.String, Schema.String),
  attachments: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      file: ChatAttachment,
      sha256: Schema.String,
      bytes: Schema.String,
    }),
  ),
});
export type ProjectMoveBundle = typeof ProjectMoveBundle.Type;
