// @effect-diagnostics nodeBuiltinImport:off - kill the actual writer process before its release finalizer.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { it, expect } from "@effect/vitest";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CommandId, ProjectId } from "@t3tools/contracts";

import {
  makeScheduleEngineLayer,
  makeScheduleFixture,
} from "../schedules/schedules.testFixtures.ts";
import {
  acquireProjectMoveFence,
  isProjectMoveFenced,
  releaseProjectMoveFence,
  reconcileAbandonedProjectWriter,
  withProjectWriter,
} from "./projectMoveFence.ts";
import { withGitWorkspaceWriter, withWorkspaceWriter } from "./projectWorkspaceWriter.ts";

it.effect(
  "refuses a fence while an external operation holds a writer and protects aliased workspace files",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "coordinator-write-" });
      const root = path.join(temp, "source");
      const alias = path.join(temp, "alias");
      yield* fs.makeDirectory(root);
      yield* fs.symlink(root, alias);
      const sql = yield* SqlClient.SqlClient;
      const fixture = yield* makeScheduleFixture;
      const id = ProjectId.make("project");
      yield* fixture.dispatch({
        type: "project.create",
        commandId: CommandId.make("create"),
        projectId: id,
        title: "Synthetic",
        workspaceRoot: root,
        createdAt: "2026-09-28T12:00:00.000Z",
      });
      const reserve = acquireProjectMoveFence(id, "move");
      const contention = yield* withProjectWriter(sql, id, Effect.flip(reserve));
      expect(contention.message).toMatch(/unfinished/);
      expect(yield* isProjectMoveFenced(id)).toBe(false);
      yield* reserve;
      let writes = 0;
      const save = withWorkspaceWriter(
        sql,
        alias,
        "notes/new.md",
        Effect.sync(() => ++writes),
      );
      expect((yield* Effect.flip(save)).message).toMatch(/paused/);
      const common = path.join(root, ".git");
      const worktree = path.join(temp, "linked");
      yield* fs.makeDirectory(path.join(common, "worktrees", "linked"), { recursive: true });
      yield* fs.makeDirectory(worktree);
      yield* fs.writeFileString(
        path.join(worktree, ".git"),
        `gitdir: ${common}/worktrees/linked\n`,
      );
      yield* fs.writeFileString(path.join(common, "worktrees", "linked", "commondir"), "../..\n");
      const gitWrite = (cwd: string, name: string, target?: string) =>
        withGitWorkspaceWriter(
          sql,
          { cwd, path: target },
          name,
          Effect.sync(() => ++writes),
        );
      for (const action of ["pullCurrentBranch", "runStackedAction", "createWorktree"]) {
        expect((yield* Effect.flip(gitWrite(worktree, action))).detail).toMatch(/paused/);
      }
      expect((yield* Effect.flip(gitWrite(temp, "removeWorktree", root))).detail).toMatch(/paused/);
      expect(writes).toBe(0);
      yield* releaseProjectMoveFence(id, "move");
      yield* save;
      expect(writes).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(makeScheduleEngineLayer("coordinator-write-"))),
);

it.effect(
  "recovers in-process writes after SIGKILL and requires a verified receipt for surviving external work",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "project-writer-crash-" });
      const dbPath = path.join(dir, "synthetic.sqlite");
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const cwd = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
        const projectFenceUrl = new URL("./projectMoveFence.ts", import.meta.url).href;
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeChildProcess.spawn(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                `
          import * as Effect from "effect/Effect";
          import * as SqlClient from "effect/unstable/sql/SqlClient";
          import * as Client from "@t3tools/shared/nodeSqliteClient";
          const { withProjectWriter } = await import(process.argv[2]);
          setInterval(() => {}, 60_000);
          await Effect.runPromise(Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const wait = Effect.sync(() => process.send("ready")).pipe(Effect.andThen(Effect.never));
            yield* withProjectWriter(sql, "local-project", withProjectWriter(sql, "external-project", wait, "provider"), "file");
          }).pipe(Effect.provide(Client.layer({filename: process.argv[1]}))));
        `,
                dbPath,
                projectFenceUrl,
              ],
              { cwd, stdio: ["ignore", "ignore", "inherit", "ipc"] },
            ),
          ),
          (child) =>
            Effect.sync(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            }),
        );
        yield* Effect.tryPromise(
          () =>
            new Promise<void>((resolve, reject) => {
              child.once("message", () => resolve());
              child.once("error", reject);
              child.once("exit", () =>
                reject(new Error("Writer exited before reserving its operation.")),
              );
            }),
        );
        const [external] = yield* sql<{
          operation_id: string;
        }>`SELECT operation_id FROM project_move_writers WHERE project_id = 'external-project'`;
        const reconcile = reconcileAbandonedProjectWriter(
          "external-project",
          external!.operation_id,
          "synthetic provider receipt confirms completion",
        );
        expect((yield* Effect.flip(reconcile)).message).toMatch(/alive/);
        const [active] = yield* sql<{ owner_generation: string | null }>`SELECT owner_generation
          FROM project_move_writers WHERE project_id = 'local-project'`;
        if (active?.owner_generation) {
          // The PID is alive, but this row belongs to a different process generation.
          yield* sql`INSERT INTO project_move_writers (project_id, operation_id, kind, owner_pid, owner_host, owner_generation)
            SELECT 'old-generation', 'old-operation', 'file', owner_pid, owner_host, 'old-generation-token'
            FROM project_move_writers WHERE project_id = 'local-project'`;
          yield* acquireProjectMoveFence("old-generation", "move");
        }
        yield* sql`INSERT INTO project_move_writers (project_id, operation_id, kind, owner_pid, owner_host)
          SELECT 'other-host', 'other-operation', 'file', owner_pid, 'synthetic-other-host'
          FROM project_move_writers WHERE project_id = 'local-project'`;
        expect((yield* Effect.flip(acquireProjectMoveFence("other-host", "move"))).message).toMatch(
          /unfinished/,
        );

        expect(
          (yield* Effect.flip(acquireProjectMoveFence("local-project", "move"))).message,
        ).toMatch(/unfinished/);
        yield* Effect.tryPromise(
          () =>
            new Promise<void>((resolve, reject) => {
              child.once("exit", (_code, signal) =>
                signal === "SIGKILL"
                  ? resolve()
                  : reject(new Error("Expected hard process termination")),
              );
              child.kill("SIGKILL");
            }),
        );
        yield* acquireProjectMoveFence("local-project", "move");
        expect(
          (yield* Effect.flip(acquireProjectMoveFence("external-project", "move"))).message,
        ).toMatch(/reconcile/);
        yield* reconcile;
        yield* reconcile;
        yield* acquireProjectMoveFence("external-project", "move");
        expect(yield* sql`SELECT operation_id FROM project_move_writer_reconciliations`).toEqual([
          { operation_id: external!.operation_id },
        ]);
      }).pipe(Effect.provide(makeSqlitePersistenceLive(dbPath)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
