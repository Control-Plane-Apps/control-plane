import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { acquireProjectMoveFence, ProjectMoveFenceError } from "./projectMoveFence.ts";

/** The tentative fence and its crash recovery instruction commit together. */
export const reserveProjectReturn = Effect.fn("projectMove.reserveReturn")(function* (
  projectId: string,
  moveId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* acquireProjectMoveFence(projectId, moveId);
      const rows = yield* sql`UPDATE project_move_receipts SET phase='checking-return'
      WHERE project_id=${projectId} AND move_id=${moveId} AND role='target'
        AND phase IN ('active', 'checking-return') RETURNING project_id`;
      if (!rows.length)
        return yield* new ProjectMoveFenceError({
          message: "Only the active destination can start a return transfer.",
        });
    }),
  );
});
