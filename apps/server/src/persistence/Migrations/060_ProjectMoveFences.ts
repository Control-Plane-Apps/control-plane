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
      project_id TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      owner_host TEXT NOT NULL,
      owner_generation TEXT,
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
