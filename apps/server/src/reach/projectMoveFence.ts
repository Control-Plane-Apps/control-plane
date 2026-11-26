// @effect-diagnostics nodeBuiltinImport:off - compare the canonical roots owned by registered Projects.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeAgentPushQueries } from "../orchestration/agentPushes.ts";

export class ProjectMoveFenceError extends Data.TaggedError("ProjectMoveFenceError")<{
  readonly message: string;
}> {}

export interface ProjectMovePermit {
  readonly projectId: string;
  readonly moveId: string;
}

// Server-only capability carried into the engine queue, never decoded from the wire.
export const ProjectMovePermitRef = Context.Reference<ProjectMovePermit | null>(
  "t3/reach/ProjectMovePermit",
  { defaultValue: () => null },
);

export const withProjectMovePermit = <A, E, R>(
  projectId: string,
  moveId: string,
  effect: Effect.Effect<A, E, R>,
) => Effect.provideService(effect, ProjectMovePermitRef, { projectId, moveId });

export const projectMoveFenceOwner = (sql: SqlClient.SqlClient, projectId: string) =>
  sql<{ move_id: string }>`
    SELECT move_id FROM project_move_fences WHERE project_id = ${projectId}
  `.pipe(Effect.map((rows) => rows[0]?.move_id ?? null));

export const isProjectMoveFenced = (projectId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => projectMoveFenceOwner(sql, projectId)).pipe(
    Effect.map((owner) => owner !== null),
  );

// Held schedules live in the runner until the next idle delivery opportunity.
const heldSchedules = new WeakMap<SqlClient.SqlClient, (projectId: string) => boolean>();
export function registerScheduleMoveCheck(
  sql: SqlClient.SqlClient,
  hasHold: (projectId: string) => boolean,
) {
  heldSchedules.set(sql, hasHold);
  return () => {
    if (heldSchedules.get(sql) === hasHold) heldSchedules.delete(sql);
  };
}

type TerminalCheck = (threadIds: ReadonlySet<string>, root: string) => Effect.Effect<boolean>;
const terminalChecks = new WeakMap<SqlClient.SqlClient, TerminalCheck>();
export function registerProjectTerminalCheck(sql: SqlClient.SqlClient, check: TerminalCheck) {
  terminalChecks.set(sql, check);
  return () => {
    if (terminalChecks.get(sql) === check) terminalChecks.delete(sql);
  };
}

const canonicalRoot = (root: string) =>
  Effect.tryPromise(() => fs.realpath(root)).pipe(Effect.orElseSucceed(() => path.resolve(root)));

export const assertProjectWorkspaceAvailable = (
  sql: SqlClient.SqlClient,
  projectId: string,
  root: string,
) =>
  Effect.gen(function* () {
    const others = yield* sql<{ workspace_root: string }>`
      SELECT p.workspace_root FROM project_move_fences f JOIN projection_projects p ON p.project_id = f.project_id
      WHERE f.project_id <> ${projectId}
    `;
    if (!others.length) return;
    const currentRoot = yield* canonicalRoot(root);
    for (const other of others) {
      if ((yield* canonicalRoot(other.workspace_root)) === currentRoot)
        return yield* new ProjectMoveFenceError({
          message: "Another moving Project owns this workspace.",
        });
    }
  });

export const acquireProjectMoveFence = Effect.fn("projectMoveFence.acquire")(function* (
  projectId: string,
  moveId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
      INSERT INTO project_move_fences (project_id, move_id) VALUES (${projectId}, ${moveId})
      ON CONFLICT (project_id) DO NOTHING
    `;
      if ((yield* projectMoveFenceOwner(sql, projectId)) !== moveId) {
        return yield* new ProjectMoveFenceError({
          message: "Another move holds the Project fence.",
        });
      }
      const writers =
        yield* sql`SELECT 1 FROM project_move_writers WHERE project_id = ${projectId} LIMIT 1`;
      if (writers.length || heldSchedules.get(sql)?.(projectId)) {
        return yield* new ProjectMoveFenceError({
          message: "The Project has an unfinished schedule or linked-agent operation.",
        });
      }
      const terminalCheck = terminalChecks.get(sql);
      const projects = yield* sql<{ project_id: string; workspace_root: string }>`
        SELECT project_id, workspace_root FROM projection_projects WHERE deleted_at IS NULL
      `;
      const project = projects.find((item) => item.project_id === projectId);
      if (project) {
        const root = yield* canonicalRoot(project.workspace_root);
        for (const other of projects) {
          if (
            other.project_id !== projectId &&
            (yield* canonicalRoot(other.workspace_root)) === root
          )
            return yield* new ProjectMoveFenceError({
              message: "Another registered Project shares this workspace.",
            });
        }
        if (terminalCheck) {
          const threads = yield* sql<{
            thread_id: string;
          }>`SELECT thread_id FROM projection_threads WHERE project_id = ${projectId}`;
          if (
            yield* terminalCheck(new Set(threads.map((t) => t.thread_id)), project.workspace_root)
          ) {
            return yield* new ProjectMoveFenceError({
              message: "Close the Project terminals before moving its coordinator.",
            });
          }
        }
      }
      const busy = yield* sql`
      SELECT 1 FROM projection_threads t WHERE t.project_id = ${projectId}
      AND (EXISTS (SELECT 1 FROM projection_thread_sessions s WHERE s.thread_id = t.thread_id
                   AND (s.status IN ('starting', 'running') OR s.active_turn_id IS NOT NULL))
        OR EXISTS (SELECT 1 FROM projection_turns r WHERE r.thread_id = t.thread_id
                   AND r.state IN ('pending', 'running'))
        OR EXISTS (SELECT 1 FROM projection_pending_approvals a WHERE a.thread_id = t.thread_id AND a.status = 'pending'))
      LIMIT 1
    `;
      const id = ProjectId.make(projectId);
      const deliveries = makeAgentPushQueries(sql);
      if (
        busy.length ||
        (yield* deliveries.listDeliveries(id)).length ||
        (yield* deliveries.listOwedResults(id)).length ||
        (yield* deliveries.listOwedContinuations(id)).length
      ) {
        return yield* new ProjectMoveFenceError({
          message: "Wait for Project turns and agent deliveries to finish.",
        });
      }
    }),
  );
});

export const releaseProjectMoveFence = Effect.fn("projectMoveFence.release")(function* (
  projectId: string,
  moveId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const owner = yield* projectMoveFenceOwner(sql, projectId);
      if (owner !== null && owner !== moveId) {
        return yield* new ProjectMoveFenceError({
          message: "Another move holds the Project fence.",
        });
      }
      if (owner === null)
        return yield* new ProjectMoveFenceError({
          message: "The Project fence is missing. Verify ownership before resuming execution.",
        });
      const writers =
        yield* sql`SELECT 1 FROM project_move_writers WHERE project_id = ${projectId} LIMIT 1`;
      if (writers.length)
        return yield* new ProjectMoveFenceError({
          message: "A Project operation has not finished.",
        });
      yield* sql`DELETE FROM project_move_fences WHERE project_id = ${projectId} AND move_id = ${moveId}`;
    }),
  );
});

// Filesystem and peer writes span more than one SQL statement. Reserve them
// before any side effect. An interrupted process leaves a durable writer for
// recovery rather than letting a second owner claim an uncertain operation.
export function withProjectWriter<A, E, R>(
  sql: SqlClient.SqlClient,
  projectId: string,
  effect: Effect.Effect<A, E, R>,
) {
  const acquire = sql.withTransaction(
    Effect.gen(function* () {
      const [writer] = yield* sql<{ operation_id: string }>`
        INSERT INTO project_move_writers (project_id, operation_id)
        VALUES (${projectId}, lower(hex(randomblob(16)))) RETURNING operation_id
      `;
      const owner = yield* projectMoveFenceOwner(sql, projectId);
      const permit = yield* ProjectMovePermitRef;
      if (permit?.projectId === projectId ? owner !== permit.moveId : owner !== null) {
        return yield* new ProjectMoveFenceError({
          message: "This Project is paused for a coordinator move.",
        });
      }
      return writer!.operation_id;
    }),
  );
  return Effect.acquireUseRelease(
    acquire,
    () => effect,
    (operationId) =>
      sql`DELETE FROM project_move_writers WHERE operation_id = ${operationId}`.pipe(Effect.orDie),
  );
}
