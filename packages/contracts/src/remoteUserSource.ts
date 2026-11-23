import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A user answer forwarded by the verified machine running the Assistant. */
export const OrchestrationRemoteUserMessageSource = Schema.Struct({
  kind: Schema.Literal("remote-user"),
  environmentId: TrimmedNonEmptyString,
  label: Schema.String,
  /** The Assistant thread there, never a local thread id. */
  threadId: ThreadId,
});
export type OrchestrationRemoteUserMessageSource = typeof OrchestrationRemoteUserMessageSource.Type;
