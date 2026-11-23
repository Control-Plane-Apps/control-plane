import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Linked-machine token renewal (agentMachines/linkToken.ts).
 *
 * - `agent_machine_link_renewals` records each link session that renewed, so a
 *   token renews at most once: a second holder of the same token is refused.
 * - Link sessions from 0.0.91 were exchanged from general pairing links with
 *   subject `one-time-token`. They are recognized by their exact read and
 *   operate scopes and the labels this fork gave them, and tagged
 *   `agent-machine-link` so they may renew once and name their holder. No other
 *   client session becomes renewable.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_machine_link_renewals (
      parent_session_id TEXT PRIMARY KEY,
      child_session_id TEXT NOT NULL,
      renewed_at TEXT NOT NULL
    )
  `;
  yield* sql`
    UPDATE auth_sessions
    SET subject = 'agent-machine-link'
    WHERE subject = 'one-time-token'
      AND method = 'bearer-access-token'
      AND revoked_at IS NULL
      AND scopes IN (
        '["orchestration:read","orchestration:operate"]',
        '["orchestration:operate","orchestration:read"]'
      )
      AND (client_label LIKE 'Agent placement from %' OR client_label LIKE 'Link back from %')
  `;
});
