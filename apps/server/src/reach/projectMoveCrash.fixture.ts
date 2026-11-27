// @effect-diagnostics nodeBuiltinImport:off - constrain the crash probe to its disposable database.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { reserveProjectReturn } from "./projectMoveReturnFence.ts";

const [dbPath, projectId, moveId] = process.argv.slice(2);
if (!dbPath || projectId !== "target-project" || moveId !== "synthetic-move")
  throw new Error("Missing synthetic recovery fixture.");
const relative = NodePath.relative(
  await NodeFSP.realpath(NodeOS.tmpdir()),
  await NodeFSP.realpath(dbPath),
);
if (!/^project-move-pair-[^/\\]+[/\\]destination[/\\]/.test(relative))
  throw new Error("Expected a disposable coordinator move database.");
// Terminate immediately after the real SQLite transaction commits. The parent
// reopens both environments and exercises the public retry path.
await Effect.runPromise(
  reserveProjectReturn(projectId, moveId).pipe(
    Effect.andThen(Effect.sync(() => process.kill(process.pid, "SIGKILL"))),
    Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
  ),
);
