/**
 * Projection rows for tasks and period intents. Fork-owned. Each row holds the
 * whole record as JSON, written by the tasks projector and read back into the
 * command read model and the shell snapshot.
 */
import { Task, TaskIntent, taskIntentKey, type TaskHorizon } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeError, toPersistenceSqlError } from "./Errors.ts";

const decodeTask = Schema.decodeUnknownEffect(Schema.fromJsonString(Task));
const decodeIntent = Schema.decodeUnknownEffect(Schema.fromJsonString(TaskIntent));

export const upsertTaskRow = (sql: SqlClient.SqlClient, task: Task) =>
  sql`
    INSERT INTO projection_tasks (task_id, task_json, updated_at)
    VALUES (${task.id}, ${JSON.stringify(task)}, ${task.updatedAt})
    ON CONFLICT (task_id) DO UPDATE SET
      task_json = excluded.task_json,
      updated_at = excluded.updated_at
  `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("ProjectionTasks.upsert")));

export const deleteTaskRow = (sql: SqlClient.SqlClient, taskId: string) =>
  sql`DELETE FROM projection_tasks WHERE task_id = ${taskId}`.pipe(
    Effect.asVoid,
    Effect.mapError(toPersistenceSqlError("ProjectionTasks.delete")),
  );

export const upsertTaskIntentRow = (sql: SqlClient.SqlClient, intent: TaskIntent) =>
  sql`
    INSERT INTO projection_task_intents (intent_key, intent_json, updated_at)
    VALUES (
      ${taskIntentKey(intent.horizon, intent.startsOn)},
      ${JSON.stringify(intent)},
      ${intent.updatedAt}
    )
    ON CONFLICT (intent_key) DO UPDATE SET
      intent_json = excluded.intent_json,
      updated_at = excluded.updated_at
  `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("ProjectionTaskIntents.upsert")));

export const deleteTaskIntentRow = (
  sql: SqlClient.SqlClient,
  horizon: TaskHorizon,
  startsOn: string,
) =>
  sql`DELETE FROM projection_task_intents WHERE intent_key = ${taskIntentKey(horizon, startsOn)}`.pipe(
    Effect.asVoid,
    Effect.mapError(toPersistenceSqlError("ProjectionTaskIntents.delete")),
  );

export const listTasks = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly taskJson: string }>`
      SELECT task_json AS "taskJson" FROM projection_tasks ORDER BY rowid ASC
    `.pipe(Effect.mapError(toPersistenceSqlError("ProjectionTasks.list:query")));
    return yield* Effect.forEach(rows, (row) =>
      decodeTask(row.taskJson).pipe(
        Effect.mapError(toPersistenceDecodeError("ProjectionTasks.list:decode")),
      ),
    );
  });

export const getTask = (sql: SqlClient.SqlClient, taskId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly taskJson: string }>`
      SELECT task_json AS "taskJson" FROM projection_tasks WHERE task_id = ${taskId}
    `.pipe(Effect.mapError(toPersistenceSqlError("ProjectionTasks.get:query")));
    const row = rows[0];
    if (row === undefined) return null;
    return yield* decodeTask(row.taskJson).pipe(
      Effect.mapError(toPersistenceDecodeError("ProjectionTasks.get:decode")),
    );
  });

export const listTaskIntents = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly intentJson: string }>`
      SELECT intent_json AS "intentJson" FROM projection_task_intents ORDER BY intent_key ASC
    `.pipe(Effect.mapError(toPersistenceSqlError("ProjectionTaskIntents.list:query")));
    return yield* Effect.forEach(rows, (row) =>
      decodeIntent(row.intentJson).pipe(
        Effect.mapError(toPersistenceDecodeError("ProjectionTaskIntents.list:decode")),
      ),
    );
  });

export const getTaskIntent = (sql: SqlClient.SqlClient, horizon: TaskHorizon, startsOn: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ readonly intentJson: string }>`
      SELECT intent_json AS "intentJson" FROM projection_task_intents
      WHERE intent_key = ${taskIntentKey(horizon, startsOn)}
    `.pipe(Effect.mapError(toPersistenceSqlError("ProjectionTaskIntents.get:query")));
    const row = rows[0];
    if (row === undefined) return null;
    return yield* decodeIntent(row.intentJson).pipe(
      Effect.mapError(toPersistenceDecodeError("ProjectionTaskIntents.get:decode")),
    );
  });
