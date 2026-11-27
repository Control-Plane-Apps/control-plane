import {
  AgentMachinesError,
  type CoordinatorCheckoutOption,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { actualPath, workspaceRootsOverlap } from "./projectWorkspacePaths.ts";

const overlapReason = "The checkout overlaps another registered Project workspace.";
const resolve = (root: string) =>
  Effect.tryPromise({
    try: () => actualPath(root),
    catch: () =>
      new AgentMachinesError({ detail: "Could not verify the registered workspace path." }),
  });

export const checkCheckoutRoots = (
  sql: SqlClient.SqlClient,
  checkoutId: string,
  coordinatorId?: string,
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      project_id: string;
      workspace_root: string;
    }>`SELECT project_id,workspace_root
      FROM projection_projects WHERE deleted_at IS NULL`;
    const checkout = rows.find((row) => row.project_id === checkoutId);
    if (!checkout)
      return yield* new AgentMachinesError({ detail: "The checkout registration is unavailable." });
    const root = yield* resolve(checkout.workspace_root);
    for (const row of rows) {
      if (row.project_id === checkoutId || (coordinatorId && row.project_id !== coordinatorId))
        continue;
      if (workspaceRootsOverlap(root, yield* resolve(row.workspace_root)))
        return yield* new AgentMachinesError({ detail: overlapReason });
    }
  });

export const checkoutOptions = (
  projects: readonly OrchestrationProjectShell[],
  coordinatorId?: string,
) =>
  Effect.gen(function* () {
    const roots = new Map<string, string>();
    for (const p of projects) roots.set(p.id, yield* resolve(p.workspaceRoot));
    const options: CoordinatorCheckoutOption[] = [];
    for (const p of projects) {
      if (!p.repositoryIdentity || p.assistant?.archivedAt || p.assistant?.scope === "global")
        continue;
      const root = roots.get(p.id)!;
      const overlap = [...roots].some(
        ([id, other]) =>
          id !== p.id &&
          (!coordinatorId || id === coordinatorId) &&
          workspaceRootsOverlap(root, other),
      );
      options.push({
        projectId: p.id,
        title: p.title,
        workspaceRoot: p.workspaceRoot,
        repository: p.repositoryIdentity.canonicalKey,
        ...(overlap ? { blockedReason: overlapReason } : {}),
      });
    }
    return options;
  });
