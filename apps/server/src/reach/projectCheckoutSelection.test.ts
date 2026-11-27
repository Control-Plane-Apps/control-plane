import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { checkCheckoutRoots } from "./projectCheckoutSelection.ts";

it.effect(
  "refuses aliased nested source and destination registrations on their respective machines",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "checkout-overlap-" });
      const parent = path.join(root, "parent");
      const nested = path.join(parent, "repo");
      const alias = path.join(root, "nested-alias");
      yield* fs.makeDirectory(nested, { recursive: true });
      yield* fs.symlink(nested, alias);
      for (const side of ["source", "destination"] as const) {
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // On source the selected verification checkout is inside the coordinator folder.
          // On destination the selected checkout contains another registered Project.
          const checkout = side === "source" ? alias : parent;
          const other = side === "source" ? parent : alias;
          yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES ('checkout', 'Selected', ${checkout}, '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            ('other', 'Existing', ${other}, '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
          const verify = checkCheckoutRoots(
            sql,
            "checkout",
            side === "source" ? "other" : undefined,
          );
          expect((yield* Effect.flip(verify)).message).toMatch(/overlaps/);
          yield* sql`UPDATE projection_projects SET workspace_root = ${path.join(root, "sibling")} WHERE project_id = 'other'`;
          yield* verify;
        }).pipe(Effect.provide(SqlitePersistenceMemory));
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
