import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeIsolatedTestDatabase } from "./isolated-test-database.js";
import { runMigrations } from "./migrations.js";

const testDatabase = makeIsolatedTestDatabase("xpensego_migration_integration");
const runtimeClientLayer = PgClient.layer({
  url: testDatabase.runtimeUrl,
  applicationName: "xpensego-runtime-role-test",
  maxConnections: 1,
});

async function withFreshMigrationDatabase<A>(run: () => Promise<A>): Promise<A> {
  await Effect.runPromise(testDatabase.recreate);

  try {
    return await run();
  } finally {
    await Effect.runPromise(testDatabase.drop);
  }
}

describe("PostgreSQL migrations", () => {
  it("migrates an empty database and remains repeatable", async () => {
    await withFreshMigrationDatabase(async () => {
      const firstRun = await Effect.runPromise(runMigrations(testDatabase.migrationUrl));
      const secondRun = await Effect.runPromise(runMigrations(testDatabase.migrationUrl));

      expect(firstRun).toEqual([
        [1, "foundation"],
        [2, "outbox_dispatch"],
        [3, "outbox_recovery_policy"],
        [4, "queue_outcome_unknown"],
        [5, "better_auth"],
      ]);
      expect(secondRun).toEqual([]);
    });
  });

  it("keeps runtime DML separate from schema and migration authority", async () => {
    await withFreshMigrationDatabase(async () => {
      await Effect.runPromise(runMigrations(testDatabase.migrationUrl));

      const [privileges] = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql<{
            readonly canCreateInPublic: boolean;
            readonly canDeleteUsers: boolean;
            readonly canInsertInboundEvents: boolean;
            readonly canInsertOutboxMessages: boolean;
            readonly canInsertOutboxReceipts: boolean;
            readonly canInsertMigrations: boolean;
            readonly canUpdateOutboxPayload: boolean;
            readonly canUpdateOutboxStatus: boolean;
            readonly roleName: string;
          }>`
            SELECT
              current_user AS "roleName",
              has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreateInPublic",
              has_table_privilege(current_user, 'users', 'DELETE') AS "canDeleteUsers",
              has_table_privilege(current_user, 'inbound_channel_events', 'INSERT')
                AS "canInsertInboundEvents",
              has_table_privilege(current_user, 'outbox_messages', 'INSERT')
                AS "canInsertOutboxMessages",
              has_column_privilege(current_user, 'outbox_messages', 'status', 'UPDATE')
                AS "canUpdateOutboxStatus",
              has_column_privilege(current_user, 'outbox_messages', 'payload', 'UPDATE')
                AS "canUpdateOutboxPayload",
              has_table_privilege(current_user, 'outbox_message_receipts', 'INSERT')
                AS "canInsertOutboxReceipts",
              has_table_privilege(current_user, 'xpensego_migrations', 'INSERT')
                AS "canInsertMigrations"
          `;
        }).pipe(Effect.provide(runtimeClientLayer), Effect.scoped),
      );

      expect(privileges).toEqual({
        roleName: "xpensego_runtime",
        canCreateInPublic: false,
        canDeleteUsers: false,
        canInsertInboundEvents: true,
        canInsertOutboxMessages: true,
        canInsertOutboxReceipts: true,
        canInsertMigrations: false,
        canUpdateOutboxPayload: false,
        canUpdateOutboxStatus: true,
      });
    });
  });
});
