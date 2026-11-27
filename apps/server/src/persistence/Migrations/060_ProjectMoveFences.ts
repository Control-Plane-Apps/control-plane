import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE project_move_fences (
      project_id TEXT PRIMARY KEY NOT NULL,
      move_id TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE project_move_writers (
      operation_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT,
      owner_pid INTEGER NOT NULL,
      owner_host TEXT NOT NULL,
      owner_generation TEXT,
      terminal_cwd TEXT,
      terminal_worktree TEXT,
      terminal_thread TEXT,
      terminal_pid INTEGER,
      terminal_generation TEXT,
      kind TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  yield* sql`
    CREATE TABLE project_move_writer_reconciliations (
      operation_id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      owner_host TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      kind TEXT NOT NULL,
      evidence TEXT NOT NULL,
      reconciled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  yield* sql`
    CREATE INDEX project_move_writers_project ON project_move_writers(project_id)
  `;
  yield* sql`
    CREATE TABLE project_move_provider_restarts (
      thread_id TEXT PRIMARY KEY NOT NULL,
      move_id TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE project_move_agent_relays (
      home_project_id TEXT NOT NULL, move_id TEXT NOT NULL, worker_id TEXT NOT NULL,
      worker_project_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      PRIMARY KEY(home_project_id,move_id,worker_id,worker_project_id,thread_id)
    )
  `;
  yield* sql`CREATE TABLE project_move_history_claims (
    kind TEXT NOT NULL, identity TEXT NOT NULL, owner TEXT NOT NULL, proof TEXT,
    project_id TEXT NOT NULL, move_id TEXT NOT NULL, PRIMARY KEY(kind,identity)
  )`;
  yield* sql`CREATE INDEX project_move_history_claims_move ON project_move_history_claims(project_id,move_id)`;
  yield* sql`CREATE TRIGGER project_move_release_history AFTER DELETE ON project_move_fences
    BEGIN DELETE FROM project_move_history_claims WHERE project_id=OLD.project_id AND move_id=OLD.move_id; END`;
  // These UPSERT targets use database-wide IDs. Protect both sides of the rollback
  // handshake, including other server processes and background projection writers.
  for (const [kind, table, id, owner] of [
    ["thread", "projection_threads", "thread_id", "'local:'||NEW.project_id"],
    ["message", "projection_thread_messages", "message_id", "NEW.thread_id"],
    ["activity", "projection_thread_activities", "activity_id", "NEW.thread_id"],
    ["plan", "projection_thread_proposed_plans", "plan_id", "NEW.thread_id"],
    ["approval", "projection_pending_approvals", "request_id", "NEW.thread_id"],
    [
      "receipt",
      "orchestration_command_receipts",
      "command_id",
      "NEW.aggregate_kind||':'||NEW.aggregate_id",
    ],
  ] as const) {
    const proof =
      kind === "receipt" ? " OR proof <> json_array(NEW.accepted_at,NEW.status,NEW.error)" : "";
    for (const action of ["INSERT", "UPDATE"]) {
      yield* sql.unsafe(`CREATE TRIGGER project_move_guard_${kind}_${action} BEFORE ${action} ON ${table}
        WHEN EXISTS(SELECT 1 FROM project_move_history_claims WHERE kind='${kind}' AND identity=NEW.${id}
        AND (owner <> (${owner})${proof}))
        BEGIN SELECT RAISE(ABORT,'History identity is reserved for a Project move'); END`);
    }
  }
  // Some projectors update an existing row using its stored owner. Check the
  // actual incoming event as well, before a competing thread can alter that row.
  // Decode only while a claim exists. Malformed history cannot be projected.
  for (const [kind, type, identity] of [
    ["message", "thread.message-sent", "NEW.payload_json->>'messageId'"],
    ["activity", "thread.activity-appended", "NEW.payload_json->>'$.activity.id'"],
    ["plan", "thread.proposed-plan-upserted", "NEW.payload_json->>'$.proposedPlan.id'"],
    [
      "approval",
      "thread.activity-appended",
      "coalesce(NEW.payload_json->>'$.activity.payload.requestId', CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json->>'requestId' END)",
    ],
    ["approval", "thread.approval-response-requested", "NEW.payload_json->>'requestId'"],
  ] as const) {
    yield* sql.unsafe(`CREATE TRIGGER project_move_event_${kind}_${type.replaceAll(/[.-]/g, "_")} BEFORE INSERT ON orchestration_events
      WHEN NEW.event_type='${type}' AND CASE
        WHEN NOT EXISTS(SELECT 1 FROM project_move_history_claims WHERE kind='${kind}') THEN 0
        WHEN NOT json_valid(NEW.payload_json) THEN 0
        ELSE EXISTS(SELECT 1 FROM project_move_history_claims
          WHERE kind='${kind}' AND identity=(${identity}) AND owner<>NEW.stream_id)
      END
      BEGIN SELECT RAISE(ABORT,'History identity is reserved for a Project move'); END`);
  }
  yield* sql`
    CREATE TABLE project_move_receipts (
      move_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      peer_project_id TEXT NOT NULL,
      role TEXT NOT NULL,
      phase TEXT NOT NULL,
      digest TEXT,
      backup TEXT,
      return_bundle TEXT,
      target_digest TEXT,
      requirements TEXT,
      PRIMARY KEY(project_id, move_id)
    )
  `;
});
