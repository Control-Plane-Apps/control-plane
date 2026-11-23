import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("059_AgentMachineLinkRenewals", (it) => {
  it.effect("tags only 0.0.91 machine-link sessions, and creates the renewal ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      const insert = (
        id: string,
        subject: string,
        scopes: string,
        label: string | null,
        revokedAt: string | null = null,
        userAgent: string | null = null,
      ) => sql`
        INSERT INTO auth_sessions (
          session_id, subject, scopes, method, client_label, client_user_agent, client_device_type,
          issued_at, expires_at, revoked_at
        ) VALUES (
          ${id}, ${subject}, ${scopes}, 'bearer-access-token', ${label}, ${userAgent}, 'unknown',
          '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', ${revokedAt}
        )
      `;
      const link = '["orchestration:read","orchestration:operate"]';
      yield* insert("placement", "one-time-token", link, "Agent placement from MacBook");
      yield* insert("linkback", "one-time-token", link, "Link back from Mac mini");
      yield* insert("phone", "one-time-token", link, "iPhone");
      // The real MacBook and mini link: the pairing link's label won, the exchange came from Node.
      yield* insert("labelled", "one-time-token", link, "Mac mini agent link", null, "node");
      // A script with the same narrow scopes stays a plain client.
      yield* insert(
        "bots",
        "one-time-token",
        link,
        "Bots persistent routing",
        null,
        "Python-urllib/3.9",
      );
      yield* insert(
        "broad",
        "one-time-token",
        '["orchestration:read","orchestration:operate","access:write"]',
        "Agent placement from MacBook",
      );
      yield* insert("revoked", "one-time-token", link, "Agent placement from X", "2026-11-02");

      yield* runMigrations({ toMigrationInclusive: 59 });

      const rows = yield* sql<{ readonly sessionId: string; readonly subject: string }>`
        SELECT session_id AS "sessionId", subject FROM auth_sessions ORDER BY session_id
      `;
      assert.deepStrictEqual(Object.fromEntries(rows.map((row) => [row.sessionId, row.subject])), {
        bots: "one-time-token",
        broad: "one-time-token",
        labelled: "agent-machine-link",
        linkback: "agent-machine-link",
        phone: "one-time-token",
        placement: "agent-machine-link",
        revoked: "one-time-token",
      });
      const ledger = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM agent_machine_link_renewals
      `;
      assert.strictEqual(ledger[0]?.n, 0);
    }),
  );
});
