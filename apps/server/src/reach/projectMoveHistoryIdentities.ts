import type { ProjectMoveBundle } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { projectMoveFenceOwner } from "./projectMoveFence.ts";

class HistoryIdentityError extends Data.TaggedError("HistoryIdentityError")<{ message: string }> {}

export const releaseReturnIdentities = (
  sql: SqlClient.SqlClient,
  projectId: string,
  moveId: string,
) =>
  sql`DELETE FROM project_move_history_claims WHERE project_id=${projectId} AND move_id=${moveId}`.pipe(
    Effect.asVoid,
  );

type Claim = { kind: string; id: string; owner: string; proof: string | null };

const encodeClaims = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        id: Schema.String,
        owner: Schema.String,
        proof: Schema.NullOr(Schema.String),
      }),
    ),
  ),
);
/** One original message/plan/activity may have many updates, always in the same thread. */
function historyClaims(bundle: ProjectMoveBundle, projectId: string) {
  const claims = new Map<string, Claim>();
  const add = (kind: string, id: string, owner: string, proof: string | null = null) => {
    const key = JSON.stringify([kind, id]);
    const previous = claims.get(key);
    if (previous && (previous.owner !== owner || previous.proof !== proof))
      throw new HistoryIdentityError({
        message: "A " + kind + " identity belongs to different threads in the returning history.",
      });
    claims.set(key, { kind, id, owner, proof });
  };
  for (const thread of bundle.threads) {
    add("thread", thread.id, "local:" + projectId);
    for (const event of thread.events) {
      if (event.type === "thread.message-sent") add("message", event.payload.messageId, thread.id);
      if (event.type === "thread.proposed-plan-upserted")
        add("plan", event.payload.proposedPlan.id, thread.id);
      if (event.type === "thread.approval-response-requested")
        add("approval", event.payload.requestId, thread.id);
      if (event.type === "thread.activity-appended") {
        add("activity", event.payload.activity.id, thread.id);
        const payload = event.payload.activity.payload;
        const requestId =
          typeof payload === "object" &&
          payload !== null &&
          "requestId" in payload &&
          typeof payload.requestId === "string"
            ? payload.requestId
            : event.metadata.requestId;
        if (requestId) add("approval", requestId, thread.id);
      }
    }
  }
  for (const agent of bundle.agents) add("thread", agent.threadId, "remote:" + projectId);
  for (const receipt of bundle.receipts) {
    const aggregate = receipt.aggregateKind === "project" ? projectId : receipt.aggregateId;
    add(
      "receipt",
      receipt.commandId,
      receipt.aggregateKind + ":" + aggregate,
      JSON.stringify([receipt.acceptedAt, receipt.status, receipt.error]),
    );
  }
  return Array.from(claims.values());
}

/** Commit the reservation together with the observations. Other Projects may keep writing
 * unrelated identities. SQLite checks every competing projection/receipt insert or update. */
export const reserveHistoryIdentities = (
  sql: SqlClient.SqlClient,
  projectId: string,
  moveId: string,
  bundle: ProjectMoveBundle,
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      if ((yield* projectMoveFenceOwner(sql, projectId)) !== moveId)
        return yield* new HistoryIdentityError({ message: "The Project move fence is missing." });
      const claims = yield* Effect.try({
        try: () => historyClaims(bundle, projectId),
        catch: (cause) =>
          new HistoryIdentityError({
            message: cause instanceof Error ? cause.message : "Invalid history identity.",
          }),
      });
      yield* releaseReturnIdentities(sql, projectId, moveId);
      const json = yield* encodeClaims(claims);
      const busy = yield* sql`SELECT 1 FROM json_each(${json}) j JOIN project_move_history_claims c
      ON c.kind=j.value->>'kind' AND c.identity=j.value->>'id' LIMIT 1`;
      if (busy.length)
        return yield* new HistoryIdentityError({
          message: "Another Project move has reserved a returning history identity.",
        });
      yield* sql`INSERT INTO project_move_history_claims (kind,identity,owner,proof,project_id,move_id)
      SELECT value->>'kind',value->>'id',value->>'owner',value->>'proof',${projectId},${moveId} FROM json_each(${json})`;
      const [collision] = yield* sql<{
        kind: string;
      }>`SELECT c.kind FROM project_move_history_claims c WHERE c.project_id=${projectId}
      AND c.move_id=${moveId} AND (
      (c.kind='thread' AND EXISTS(SELECT 1 FROM projection_threads p WHERE p.thread_id=c.identity AND 'local:'||p.project_id<>c.owner))
      OR (c.kind='message' AND EXISTS(SELECT 1 FROM projection_thread_messages p WHERE p.message_id=c.identity AND p.thread_id<>c.owner))
      OR (c.kind='plan' AND EXISTS(SELECT 1 FROM projection_thread_proposed_plans p WHERE p.plan_id=c.identity AND p.thread_id<>c.owner))
      OR (c.kind='activity' AND EXISTS(SELECT 1 FROM projection_thread_activities p WHERE p.activity_id=c.identity AND p.thread_id<>c.owner))
      OR (c.kind='approval' AND EXISTS(SELECT 1 FROM projection_pending_approvals p WHERE p.request_id=c.identity AND p.thread_id<>c.owner))
      OR (c.kind='receipt' AND EXISTS(SELECT 1 FROM orchestration_command_receipts p WHERE p.command_id=c.identity AND
        (p.aggregate_kind||':'||p.aggregate_id<>c.owner OR json_array(p.accepted_at,p.status,p.error)<>c.proof)))
      ) LIMIT 1`;
      if (collision)
        return yield* new HistoryIdentityError({
          message: "A returning " + collision.kind + " identity collides on this machine.",
        });
    }),
  );
