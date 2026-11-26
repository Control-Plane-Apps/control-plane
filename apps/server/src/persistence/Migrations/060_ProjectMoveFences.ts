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
      project_id TEXT NOT NULL
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
    CREATE TABLE project_move_receipts (
      move_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      peer_project_id TEXT NOT NULL,
      role TEXT NOT NULL,
      phase TEXT NOT NULL,
      digest TEXT,
      backup TEXT,
      target_digest TEXT,
      requirements TEXT,
      PRIMARY KEY(project_id, move_id)
    )
  `;
});
