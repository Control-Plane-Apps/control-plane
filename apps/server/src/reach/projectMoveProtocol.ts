import { AgentIntegration, ModelSelection, ProjectMoveBundle } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const CheckoutProof = Schema.Struct({
  repository: Schema.String,
  branch: Schema.String,
  commit: Schema.String,
  digest: Schema.String,
});
export const MoveRequirements = Schema.Struct({
  checkout: CheckoutProof,
  scheduleZone: Schema.NullOr(Schema.String),
  model: ModelSelection,
  integrations: Schema.Array(AgentIntegration),
});
const binding = {
  projectId: Schema.NonEmptyString,
  peerProjectId: Schema.NonEmptyString,
  moveId: Schema.NonEmptyString,
};
export const ProjectMoveStep = Schema.Union([
  Schema.Struct({
    ...binding,
    action: Schema.Literal("preflight"),
    requirements: MoveRequirements,
  }),
  Schema.Struct({
    ...binding,
    action: Schema.Literal("stage"),
    targetDigest: Schema.String,
    requirements: MoveRequirements,
    digest: Schema.String,
    bundle: ProjectMoveBundle,
  }),
  Schema.Struct({ ...binding, action: Schema.Literal("activate"), digest: Schema.String }),
  Schema.Struct({ ...binding, action: Schema.Literal("reverse") }),
  Schema.Struct({
    ...binding,
    action: Schema.Literal("finishRollback"),
    returnedDigest: Schema.optionalKey(Schema.String),
  }),
]);
export type ProjectMoveStep = typeof ProjectMoveStep.Type;
export const ProjectMoveReply = Schema.Struct({
  phase: Schema.String,
  digest: Schema.optionalKey(Schema.String),
  bundle: Schema.optionalKey(ProjectMoveBundle),
});
export type ProjectMoveReply = typeof ProjectMoveReply.Type;
