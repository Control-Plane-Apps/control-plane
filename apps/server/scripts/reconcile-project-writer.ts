#!/usr/bin/env node
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import { reconcileAbandonedProjectWriter } from "../src/reach/projectMoveFence.ts";

const [database, projectId, operationId, evidence, ...extra] = process.argv.slice(2);
if (!database || !projectId || !operationId || !evidence?.trim() || extra.length) {
  throw new Error(
    "Usage: node reconcile-project-writer.ts DATABASE PROJECT_ID OPERATION_ID 'verified outcome and evidence reference'",
  );
}
// This is operator tooling. Never create a database from a mistyped path.
NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.access(database, { readable: true, writable: true });
    yield* reconcileAbandonedProjectWriter(projectId, operationId, evidence).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: database })),
    );
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);
