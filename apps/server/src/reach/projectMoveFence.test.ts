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
  withProjectWriter,
} from "./projectMoveFence.ts";
import { withWorkspaceWriter } from "./projectWorkspaceWriter.ts";

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
      expect(writes).toBe(0);
      yield* releaseProjectMoveFence(id, "move");
      yield* save;
      expect(writes).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(makeScheduleEngineLayer("coordinator-write-"))),
);
