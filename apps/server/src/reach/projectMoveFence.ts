// @effect-diagnostics nodeBuiltinImport:off - compare the canonical roots owned by registered Projects.
import * as NodeChildProcess from "node:child_process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { actualPath, workspaceRootsOverlap } from "./projectWorkspacePaths.ts";
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
  Effect.tryPromise(() => actualPath(NodePath.resolve(root))).pipe(
    Effect.mapError(
      () =>
        new ProjectMoveFenceError({ message: "Could not verify the registered workspace path." }),
    ),
  );

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
      if (workspaceRootsOverlap(yield* canonicalRoot(other.workspace_root), currentRoot))
        return yield* new ProjectMoveFenceError({
          message: "Another moving Project owns this workspace.",
        });
    }
  });

export type ProjectWriterKind =
  | "file"
  | "git"
  | "terminal"
  | "schedule"
  | "status"
  | "provider"
  | "peer";

interface WriterRow {
  readonly operation_id: string;
  readonly project_id: string | null;
  readonly terminal_cwd: string | null;
  readonly terminal_worktree: string | null;
  readonly terminal_thread: string | null;
  readonly owner_pid: number;
  readonly owner_host: string;
  readonly owner_generation: string | null;
  readonly terminal_pid: number | null;
  readonly terminal_generation: string | null;
  readonly kind: ProjectWriterKind;
}

// Prefer a kernel boot identifier plus start tick on Linux. Darwin's ps
// reports a process start second. A matching or unavailable token is always
// treated as live, including an ambiguous same-second PID reuse.
function processGeneration(platform: NodeJS.Platform, pid: number): string | null {
  try {
    if (platform === "linux") {
      const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
      const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      const bootId = NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return started && /^\d+$/.test(started) && bootId ? `${bootId}/${started}` : null;
    }
    if (platform === "darwin") {
      const started = NodeChildProcess.execFileSync(
        "/bin/ps",
        ["-p", String(pid), "-o", "lstart="],
        {
          encoding: "utf8",
          env: { LC_ALL: "C", TZ: "UTC" },
          timeout: 1000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      return started || null;
    }
  } catch {
    /* Unavailable process metadata never proves death. */
  }
  return null;
}
const ownGenerations = new Map<NodeJS.Platform, string | null>();
function currentGeneration(platform: NodeJS.Platform) {
  if (!ownGenerations.has(platform))
    ownGenerations.set(platform, processGeneration(platform, process.pid));
  return ownGenerations.get(platform) ?? null;
}

function ownerIsGone(writer: WriterRow, platform: NodeJS.Platform) {
  if (
    writer.owner_host !== NodeOS.hostname() ||
    !Number.isSafeInteger(writer.owner_pid) ||
    writer.owner_pid <= 0
  )
    return false;
  try {
    process.kill(writer.owner_pid, 0);
    const observed =
      writer.owner_pid === process.pid
        ? currentGeneration(platform)
        : processGeneration(platform, writer.owner_pid);
    return (
      writer.owner_generation !== null && observed !== null && observed !== writer.owner_generation
    );
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function terminalProcessGone(writer: WriterRow, platform: NodeJS.Platform) {
  return (
    writer.terminal_pid !== null &&
    ownerIsGone(
      {
        ...writer,
        owner_pid: writer.terminal_pid,
        owner_generation: writer.terminal_generation,
      },
      platform,
    )
  );
}

// Ownership can be established after a terminal opened, for example by
// registering its existing checkout. Resolve against the current projections
// and the paths recorded at spawn even when the launch had no Project ID.
const projectWriters = (sql: SqlClient.SqlClient, projectId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<WriterRow>`SELECT * FROM project_move_writers
    WHERE project_id = ${projectId} OR terminal_cwd IS NOT NULL ORDER BY started_at, operation_id`;
    if (!rows.some((row) => row.project_id !== projectId)) return rows;
    const threads = yield* sql<{
      thread_id: string;
      worktree_path: string | null;
    }>`SELECT thread_id, worktree_path FROM projection_threads WHERE project_id = ${projectId}`;
    const projects = yield* sql<{
      workspace_root: string;
    }>`SELECT workspace_root FROM projection_projects WHERE project_id = ${projectId}`;
    const roots = yield* Effect.forEach(
      [
        ...projects.map((p) => p.workspace_root),
        ...threads.flatMap((t) => (t.worktree_path ? [t.worktree_path] : [])),
      ],
      canonicalRoot,
    );
    const belongs = (target: string | null) =>
      target !== null &&
      roots.some((root) => {
        const relative = NodePath.relative(root, target);
        return (
          relative !== ".." &&
          !relative.startsWith(`..${NodePath.sep}`) &&
          !NodePath.isAbsolute(relative)
        );
      });
    return rows.filter(
      (row) =>
        row.project_id === projectId ||
        threads.some((t) => row.terminal_thread === t.thread_id) ||
        belongs(row.terminal_cwd) ||
        belongs(row.terminal_worktree),
    );
  });

// Operator-only recovery, intentionally absent from RPC. Stable operator evidence
// records who checked the surviving peer, child processes and durable results.
export const reconcileAbandonedProjectWriter = Effect.fn(
  "projectMoveFence.reconcileAbandonedWriter",
)(function* (projectId: string, operationId: string, evidence: string) {
  const sql = yield* SqlClient.SqlClient;
  if (!evidence.trim())
    return yield* new ProjectMoveFenceError({
      message: "Supply the evidence used to verify that external work ended.",
    });
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const writer = (yield* projectWriters(sql, projectId)).find(
        (row) => row.operation_id === operationId,
      );
      if (!writer) {
        const recorded =
          yield* sql`SELECT 1 FROM project_move_writer_reconciliations WHERE project_id = ${projectId}
        AND operation_id = ${operationId} AND evidence = ${evidence}`;
        if (recorded.length) return;
        return yield* new ProjectMoveFenceError({ message: "No matching unfinished writer." });
      }
      const platform = yield* HostProcessPlatform;
      if (writer.terminal_pid !== null && !terminalProcessGone(writer, platform))
        return yield* new ProjectMoveFenceError({
          message: "The terminal process is still alive or its exit cannot be verified.",
        });
      if (!ownerIsGone(writer, platform))
        return yield* new ProjectMoveFenceError({
          message: "The writer owner is still alive or its death cannot be verified on this host.",
        });
      yield* sql`INSERT INTO project_move_writer_reconciliations (project_id, operation_id, kind, owner_pid, owner_host, evidence)
      VALUES (${projectId}, ${operationId}, ${writer.kind}, ${writer.owner_pid}, ${writer.owner_host}, ${evidence})`;
      yield* sql`DELETE FROM project_move_writers WHERE operation_id = ${operationId}`;
    }),
  );
});

// Called after the first write in the fence transaction. The process may be
// gone while its child or peer still works. Only in-process file and engine
// operations can be reclaimed from process death alone. Capture and verify
// their current durable results before granting execution on the other side.
const reconcileProjectWriters = (sql: SqlClient.SqlClient, projectId: string) =>
  Effect.gen(function* () {
    const writers = yield* projectWriters(sql, projectId);
    for (const writer of writers) {
      const platform = yield* HostProcessPlatform;
      const gone = ownerIsGone(writer, platform);
      // A manager can close before its exit callback finishes persisting. A
      // recorded PTY generation that demonstrably ended may be retired.
      if (writer.kind === "terminal" && !gone && terminalProcessGone(writer, platform)) {
        yield* sql`DELETE FROM project_move_writers WHERE operation_id = ${writer.operation_id}`;
        continue;
      }
      if (
        gone &&
        (writer.kind === "file" || writer.kind === "schedule" || writer.kind === "status")
      ) {
        yield* sql`DELETE FROM project_move_writers WHERE operation_id = ${writer.operation_id}`;
      } else {
        const detail = gone
          ? "Verify the external operation and reconcile its receipt before retrying."
          : "Wait for its owner to finish.";
        return yield* new ProjectMoveFenceError({
          message: `The Project has an unfinished ${writer.kind} operation ${writer.operation_id} (owner ${writer.owner_host}, PID ${writer.owner_pid}). ${detail}`,
        });
      }
    }
  });

export const acquireProjectMoveFence = Effect.fn("projectMoveFence.acquire")(function* (
  projectId: string,
  moveId: string,
  checkoutForProject: string | null = null,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
      INSERT INTO project_move_fences (project_id, move_id, checkout_for_project) VALUES (${projectId}, ${moveId}, ${checkoutForProject})
      ON CONFLICT (project_id) DO NOTHING
    `;
      const [owned] = yield* sql`SELECT 1 FROM project_move_fences
        WHERE project_id=${projectId} AND move_id=${moveId} AND checkout_for_project IS ${checkoutForProject}`;
      if (!owned) {
        return yield* new ProjectMoveFenceError({
          message: "Another move holds the Project fence.",
        });
      }
      yield* reconcileProjectWriters(sql, projectId);
      if (heldSchedules.get(sql)?.(projectId)) {
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
  checkoutForProject: string | null = null,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const [owner] = yield* sql<{ move_id: string; checkout_for_project: string | null }>`
        SELECT move_id, checkout_for_project FROM project_move_fences WHERE project_id=${projectId}`;
      if (
        owner &&
        (owner.move_id !== moveId || owner.checkout_for_project !== checkoutForProject)
      ) {
        return yield* new ProjectMoveFenceError({
          message: "Another move holds the Project fence.",
        });
      }
      if (!owner)
        return yield* new ProjectMoveFenceError({
          message: "The Project fence is missing. Verify ownership before resuming execution.",
        });
      yield* reconcileProjectWriters(sql, projectId);
      yield* sql`DELETE FROM project_move_fences WHERE project_id = ${projectId} AND move_id = ${moveId} AND checkout_for_project IS ${checkoutForProject}`;
    }),
  );
});

// Filesystem and peer writes span more than one SQL statement. Reserve them
// before any side effect. An interrupted process leaves a durable writer for
// recovery rather than letting a second owner claim an uncertain operation.
export function acquireProjectWriter(
  sql: SqlClient.SqlClient,
  projectId: string | null,
  kind: ProjectWriterKind,
  terminal?: { cwd: string; threadId: string; worktreePath: string | null },
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      const [writer] = yield* sql<{ operation_id: string }>`
        INSERT INTO project_move_writers (project_id, operation_id, owner_pid, owner_host, owner_generation, kind, terminal_cwd, terminal_thread, terminal_worktree)
        VALUES (${projectId}, lower(hex(randomblob(16))), ${process.pid}, ${NodeOS.hostname()}, ${currentGeneration(yield* HostProcessPlatform)}, ${kind}, ${terminal?.cwd ?? null}, ${terminal?.threadId ?? null}, ${terminal?.worktreePath ?? null}) RETURNING operation_id
      `;
      const owner = projectId === null ? null : yield* projectMoveFenceOwner(sql, projectId);
      const permit = yield* ProjectMovePermitRef;
      if (permit?.projectId === projectId ? owner !== permit.moveId : owner !== null) {
        return yield* new ProjectMoveFenceError({
          message: "This Project is paused for a coordinator move.",
        });
      }
      return writer!.operation_id;
    }),
  );
}

export const bindTerminalProcess = (
  sql: SqlClient.SqlClient,
  ids: readonly string[],
  pid: number,
) =>
  Effect.gen(function* () {
    if (!ids.length) return;
    const generation = processGeneration(yield* HostProcessPlatform, pid);
    yield* sql`UPDATE project_move_writers SET terminal_pid = ${pid}, terminal_generation = ${generation}
      WHERE ${sql.in("operation_id", ids)} AND kind = 'terminal'`;
  });

export function withProjectWriter<A, E, R>(
  sql: SqlClient.SqlClient,
  projectId: string,
  effect: Effect.Effect<A, E, R>,
  kind: ProjectWriterKind = "peer",
) {
  return Effect.acquireUseRelease(
    acquireProjectWriter(sql, projectId, kind),
    () => effect,
    (operationId) =>
      sql`DELETE FROM project_move_writers WHERE operation_id = ${operationId}`.pipe(Effect.orDie),
  );
}
