import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { DEFAULT_CATEGORIES } from "@xpensego/domain/category/default-categories";
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
        [6, "outbox_consumption_observability"],
        [7, "identity_foundation"],
        [8, "telegram_ingress"],
        [9, "telegram_processing"],
        [10, "telegram_delivery_recovery"],
        [11, "model_operations"],
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
            readonly canInsertChannelIdentities: boolean;
            readonly canInsertChannelLinkChallenges: boolean;
            readonly canDeleteUsers: boolean;
            readonly canInsertInboundEvents: boolean;
            readonly canInsertLedgers: boolean;
            readonly canInsertOutboxMessages: boolean;
            readonly canInsertOutboxReceipts: boolean;
            readonly canInsertUsers: boolean;
            readonly canSelectCategories: boolean;
            readonly canUpdateChallengeConsumption: boolean;
            readonly canUpdateChannelUnlink: boolean;
            readonly canUpdateOutboxReceiptAttempts: boolean;
            readonly canInsertMigrations: boolean;
            readonly canInsertModelAttempts: boolean;
            readonly canInsertModelBudgetAlerts: boolean;
            readonly canInsertModelOperations: boolean;
            readonly canInsertTelegramDeliveryRecoveries: boolean;
            readonly canUpdateOutboxPayload: boolean;
            readonly canUpdateModelBudgetCeiling: boolean;
            readonly canUpdateModelBudgetKillSwitch: boolean;
            readonly canUpdateModelBudgetReservation: boolean;
            readonly canUpdateModelCanonicalInput: boolean;
            readonly canUpdateModelStatus: boolean;
            readonly canUpdateOutboxStatus: boolean;
            readonly canUpdateTelegramDeliveryRecoveries: boolean;
            readonly canUpdateUserTimezone: boolean;
            readonly canSelectTelegramDeliveryRecoveries: boolean;
            readonly roleName: string;
          }>`
            SELECT
              current_user AS "roleName",
              has_schema_privilege(current_user, 'public', 'CREATE') AS "canCreateInPublic",
              has_table_privilege(current_user, 'users', 'DELETE') AS "canDeleteUsers",
              has_table_privilege(current_user, 'users', 'INSERT') AS "canInsertUsers",
              has_column_privilege(current_user, 'users', 'timezone', 'UPDATE')
                AS "canUpdateUserTimezone",
              has_table_privilege(current_user, 'ledgers', 'INSERT') AS "canInsertLedgers",
              has_table_privilege(current_user, 'categories', 'SELECT')
                AS "canSelectCategories",
              has_table_privilege(current_user, 'channel_identities', 'INSERT')
                AS "canInsertChannelIdentities",
              has_column_privilege(current_user, 'channel_identities', 'unlinked_at', 'UPDATE')
                AS "canUpdateChannelUnlink",
              has_table_privilege(current_user, 'channel_link_challenges', 'INSERT')
                AS "canInsertChannelLinkChallenges",
              has_column_privilege(
                current_user,
                'channel_link_challenges',
                'consumed_at',
                'UPDATE'
              ) AS "canUpdateChallengeConsumption",
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
              has_column_privilege(
                current_user,
                'outbox_message_receipts',
                'delivery_attempts',
                'UPDATE'
              ) AS "canUpdateOutboxReceiptAttempts",
              has_table_privilege(current_user, 'xpensego_migrations', 'INSERT')
                AS "canInsertMigrations",
              has_table_privilege(current_user, 'model_operations', 'INSERT')
                AS "canInsertModelOperations",
              has_table_privilege(current_user, 'model_budget_alert_events', 'INSERT')
                AS "canInsertModelBudgetAlerts",
              has_column_privilege(current_user, 'model_operations', 'status', 'UPDATE')
                AS "canUpdateModelStatus",
              has_column_privilege(current_user, 'model_operations', 'canonical_input', 'UPDATE')
                AS "canUpdateModelCanonicalInput",
              has_table_privilege(current_user, 'model_attempts', 'INSERT')
                AS "canInsertModelAttempts",
              has_column_privilege(
                current_user,
                'model_budget_accounts',
                'reserved_micro_usd',
                'UPDATE'
              ) AS "canUpdateModelBudgetReservation",
              has_column_privilege(
                current_user,
                'model_budget_accounts',
                'kill_switch',
                'UPDATE'
              ) AS "canUpdateModelBudgetKillSwitch",
              has_column_privilege(
                current_user,
                'model_budget_accounts',
                'ceiling_micro_usd',
                'UPDATE'
              ) AS "canUpdateModelBudgetCeiling",
              has_table_privilege(current_user, 'telegram_delivery_recoveries', 'SELECT')
                AS "canSelectTelegramDeliveryRecoveries",
              has_table_privilege(current_user, 'telegram_delivery_recoveries', 'INSERT')
                AS "canInsertTelegramDeliveryRecoveries",
              has_table_privilege(current_user, 'telegram_delivery_recoveries', 'UPDATE')
                AS "canUpdateTelegramDeliveryRecoveries"
          `;
        }).pipe(Effect.provide(runtimeClientLayer), Effect.scoped),
      );

      expect(privileges).toEqual({
        roleName: "xpensego_runtime",
        canCreateInPublic: false,
        canDeleteUsers: false,
        canInsertChannelIdentities: true,
        canInsertChannelLinkChallenges: true,
        canInsertInboundEvents: true,
        canInsertLedgers: true,
        canInsertOutboxMessages: true,
        canInsertOutboxReceipts: true,
        canInsertUsers: true,
        canSelectCategories: true,
        canUpdateChallengeConsumption: true,
        canUpdateChannelUnlink: true,
        canUpdateOutboxReceiptAttempts: true,
        canInsertMigrations: false,
        canInsertModelAttempts: true,
        canInsertModelBudgetAlerts: true,
        canInsertModelOperations: true,
        canInsertTelegramDeliveryRecoveries: false,
        canUpdateOutboxPayload: false,
        canUpdateModelBudgetCeiling: false,
        canUpdateModelBudgetKillSwitch: true,
        canUpdateModelBudgetReservation: true,
        canUpdateModelCanonicalInput: false,
        canUpdateModelStatus: true,
        canUpdateOutboxStatus: true,
        canUpdateTelegramDeliveryRecoveries: false,
        canUpdateUserTimezone: true,
        canSelectTelegramDeliveryRecoveries: false,
      });
    });
  });

  it("seeds stable categories and the documented timezone default", async () => {
    await withFreshMigrationDatabase(async () => {
      await Effect.runPromise(runMigrations(testDatabase.migrationUrl));

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const categories = yield* sql<{
            readonly id: string;
            readonly key: string;
            readonly label: string;
            readonly isFallback: boolean;
          }>`
            SELECT id, key, label, is_fallback AS "isFallback"
            FROM categories
            ORDER BY key
          `;
          const [user] = yield* sql<{ readonly timezone: string }>`
            INSERT INTO users DEFAULT VALUES
            RETURNING timezone
          `;
          return { categories, timezone: user?.timezone };
        }).pipe(Effect.provide(runtimeClientLayer), Effect.scoped),
      );

      expect(result.categories).toEqual(
        DEFAULT_CATEGORIES.map(({ id, isFallback, key, label }) => ({
          id,
          isFallback,
          key,
          label,
        })).toSorted((left, right) => left.key.localeCompare(right.key)),
      );
      expect(result.timezone).toBe("Asia/Kolkata");
    });
  });
});
