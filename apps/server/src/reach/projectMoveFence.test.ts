// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vite-plus/test";
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
  withProjectWriter,
} from "./projectMoveFence.ts";
import { withWorkspaceWriter } from "./projectWorkspaceWriter.ts";

it("refuses a fence while an external operation holds a writer and protects aliased workspace files", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "coordinator-write-"));
  const root = path.join(temp, "source");
  const alias = path.join(temp, "alias");
  try {
    await fs.mkdir(root);
    await fs.symlink(root, alias);
    await Effect.runPromise(
      Effect.gen(function* () {
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
        expect(writes).toBe(0);
        yield* releaseProjectMoveFence(id, "move");
        yield* save;
        expect(writes).toBe(1);
      }).pipe(Effect.provide(makeScheduleEngineLayer("coordinator-write-"))),
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
