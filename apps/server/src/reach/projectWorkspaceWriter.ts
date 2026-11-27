// @effect-diagnostics nodeBuiltinImport:off - resolve actual filesystem owners including aliases.
import { GitCommandError } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { SqlError } from "effect/unstable/sql/SqlError";
import { type ProjectMoveFenceError, withProjectWriter } from "./projectMoveFence.ts";

import { actualPath } from "./projectWorkspacePaths.ts";

// Linked worktrees have different paths but mutate refs in one Git directory.
async function commonGitDirectory(target: string): Promise<string | null> {
  let directory = target;
  while (true) {
    const dotGit = NodePath.join(directory, ".git");
    const stat = await NodeFSP.stat(dotGit).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (stat) {
      if (!stat.isDirectory() && !stat.isFile()) return null;
      let gitDir = dotGit;
      if (stat.isFile()) {
        if (stat.size > 8192) return null;
        const match = /^gitdir: ([^\0\r\n]+)$/.exec(
          (await NodeFSP.readFile(dotGit, "utf8")).trim(),
        );
        if (!match) return null;
        gitDir = NodePath.resolve(directory, match[1]!);
      }
      const common = await NodeFSP.readFile(NodePath.join(gitDir, "commondir"), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return ".";
          throw error;
        },
      );
      if (!common.trim() || /[\0\r\n]/.test(common.trim())) return null;
      const commonDir = await NodeFSP.realpath(NodePath.resolve(gitDir, common.trim()));
      return (await NodeFSP.stat(commonDir)).isDirectory() ? commonDir : null;
    }
    const parent = NodePath.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export function workspaceWriterProjects(
  sql: SqlClient.SqlClient,
  cwd: string,
  relativePath: string,
  threadId?: string,
  kind: "file" | "terminal" | "git" = "file",
  recursive = false,
) {
  return Effect.gen(function* () {
    const projects = yield* sql<{ project_id: string; workspace_root: string }>`
      SELECT project_id, workspace_root FROM projection_projects WHERE deleted_at IS NULL
      UNION SELECT t.project_id, t.worktree_path FROM projection_threads t
        JOIN projection_projects p ON p.project_id = t.project_id
        WHERE p.deleted_at IS NULL AND t.deleted_at IS NULL AND t.worktree_path IS NOT NULL
    `;
    if (!projects.length) return [];
    const threads =
      threadId === undefined
        ? []
        : yield* sql<{
            project_id: string;
          }>`SELECT project_id FROM projection_threads WHERE thread_id = ${threadId}`;
    const target = yield* Effect.tryPromise(() =>
      actualPath(NodePath.resolve(cwd, relativePath.trim())),
    );

    const common =
      kind === "git" && projects.length
        ? yield* Effect.tryPromise(() => commonGitDirectory(target))
        : null;
    const guardedIds = new Set<string>();
    for (const project of projects) {
      if (guardedIds.has(project.project_id)) continue;
      // Missing or inaccessible checkouts cannot alias an accessible target.
      const root = yield* Effect.tryPromise(() => NodeFSP.realpath(project.workspace_root)).pipe(
        Effect.orElseSucceed(() => NodePath.resolve(project.workspace_root)),
      );
      const relative = NodePath.relative(root, target);
      if (
        threads[0]?.project_id === project.project_id ||
        (recursive &&
          root.startsWith(target.endsWith(NodePath.sep) ? target : target + NodePath.sep)) ||
        (common !== null &&
          common ===
            (yield* Effect.tryPromise(() => commonGitDirectory(root)).pipe(
              Effect.orElseSucceed(() => null),
            ))) ||
        (relative !== ".." &&
          !relative.startsWith(`..${NodePath.sep}`) &&
          !NodePath.isAbsolute(relative))
      ) {
        guardedIds.add(project.project_id);
      }
    }
    return [...guardedIds];
  });
}

export function withWorkspaceWriter<A, E, R>(
  sql: SqlClient.SqlClient,
  cwd: string,
  relativePath: string,
  operation: Effect.Effect<A, E, R>,
  threadId?: string,
  kind: "file" | "terminal" | "git" = "file",
  recursive = false,
) {
  return Effect.gen(function* () {
    const projects = yield* workspaceWriterProjects(
      sql,
      cwd,
      relativePath,
      threadId,
      kind,
      recursive,
    );
    let guarded: Effect.Effect<A, E | ProjectMoveFenceError | SqlError, R> = operation;
    for (const id of projects) guarded = withProjectWriter(sql, id, guarded, kind);
    return yield* guarded;
  });
}

export function withGitWorkspaceWriter<A, E, R>(
  sql: SqlClient.SqlClient,
  input: {
    readonly cwd: string;
    readonly path?: string | null | undefined;
    readonly threadId?: string | undefined;
  },
  action: string,
  operation: Effect.Effect<A, E, R>,
  recursive = false,
) {
  const guard = <B, F, T>(path: string, task: Effect.Effect<B, F, T>, recursivePath: boolean) =>
    withWorkspaceWriter(
      sql,
      input.cwd,
      path,
      Effect.result(task),
      input.threadId,
      "git",
      recursivePath,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: action,
            command: "project-writer",
            cwd: input.cwd,
            detail: cause.message,
            cause,
          }),
      ),
      Effect.flatMap(Effect.fromResult),
    );
  return guard(".", input.path ? guard(input.path, operation, true) : operation, recursive);
}
