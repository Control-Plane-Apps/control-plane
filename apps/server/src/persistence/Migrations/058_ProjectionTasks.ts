import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Fork migration. Once shipped, this id never moves: the migrator only runs ids
// above the highest recorded one, so a renumbered fork migration would make
// databases skip upstream's migration at this id. Port a colliding upstream
// migration to the next free id instead.
//
// Tasks and period intents, each row the whole record as JSON like a Project's
// assistant. No task event exists before this migration, so the tasks
// projector starts at the current head instead of replaying the whole log.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_tasks (
      task_id TEXT PRIMARY KEY,
      task_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_task_intents (
      intent_key TEXT PRIMARY KEY,
      intent_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
    SELECT
      'projection.tasks',
      COALESCE(MAX(sequence), 0),
      -- The head event's time, not now: snapshots report the newest cursor time.
      COALESCE(MAX(occurred_at), '1970-01-01T00:00:00.000Z')
    FROM orchestration_events
    WHERE NOT EXISTS (SELECT 1 FROM projection_state WHERE projector = 'projection.tasks')
  `;
});
