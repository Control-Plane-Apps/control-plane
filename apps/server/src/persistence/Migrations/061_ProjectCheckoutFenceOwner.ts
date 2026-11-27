import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Existing rows fence coordinator execution. Additional verification checkout
  // fences belong to the moving Project and live only through the acknowledgement.
  yield* sql`ALTER TABLE project_move_fences ADD COLUMN checkout_for_project TEXT`;
});
