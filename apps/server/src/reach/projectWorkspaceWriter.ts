// @effect-diagnostics nodeBuiltinImport:off - resolve actual filesystem owners including aliases.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { SqlError } from "effect/unstable/sql/SqlError";
import { type ProjectMoveFenceError, withProjectWriter } from "./projectMoveFence.ts";

// A new file or directory may not exist yet. Its nearest existing parent
// still tells us whether a workspace symlink leads into a fenced Project.
async function actualPath(input: string, links = new Set<string>()): Promise<string> {
  try {
    return await fs.realpath(input);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    // realpath also returns ENOENT for a dangling link. A write follows it
    // and may create the missing target in another Project.
    const link = await fs.readlink(input).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EINVAL") return null;
      throw error;
    });
    if (link !== null) {
      if (links.has(input)) throw new Error("Workspace path contains a symlink loop.");
      links.add(input);
      return actualPath(path.resolve(path.dirname(input), link), links);
    }
    const parent = path.dirname(input);
    if (parent === input) throw cause;
    return path.join(await actualPath(parent, links), path.basename(input));
  }
}

export function withWorkspaceWriter<A, E, R>(
  sql: SqlClient.SqlClient,
  cwd: string,
  relativePath: string,
  operation: Effect.Effect<A, E, R>,
  threadId?: string,
) {
  return Effect.gen(function* () {
    const projects = yield* sql<{ project_id: string; workspace_root: string }>`
      SELECT project_id, workspace_root FROM projection_projects WHERE deleted_at IS NULL
    `;
    const threads =
      threadId === undefined
        ? []
        : yield* sql<{
            project_id: string;
          }>`SELECT project_id FROM projection_threads WHERE thread_id = ${threadId}`;
    const target = yield* Effect.tryPromise(() =>
      actualPath(path.resolve(cwd, relativePath.trim())),
    );
    let guarded: Effect.Effect<A, E | ProjectMoveFenceError | SqlError, R> = operation;
    for (const project of projects) {
      // Missing or inaccessible checkouts cannot alias an accessible target.
      const root = yield* Effect.tryPromise(() => fs.realpath(project.workspace_root)).pipe(
        Effect.orElseSucceed(() => path.resolve(project.workspace_root)),
      );
      const relative = path.relative(root, target);
      if (
        threads[0]?.project_id === project.project_id ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      ) {
        guarded = withProjectWriter(sql, project.project_id, guarded);
      }
    }
    return yield* guarded;
  });
}
