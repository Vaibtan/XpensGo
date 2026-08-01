import { Migrator } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { Effect, type Redacted } from "effect";

import { foundationMigration } from "./migrations/0001-foundation.js";
import { outboxDispatchMigration } from "./migrations/0002-outbox-dispatch.js";
import { outboxRecoveryPolicyMigration } from "./migrations/0003-outbox-recovery-policy.js";
import { queueOutcomeUnknownMigration } from "./migrations/0004-queue-outcome-unknown.js";
import { betterAuthMigration } from "./migrations/0005-better-auth.js";

const migrationProgram = Migrator.make({})({
  loader: Migrator.fromRecord({
    "0001_foundation": foundationMigration,
    "0002_outbox_dispatch": outboxDispatchMigration,
    "0003_outbox_recovery_policy": outboxRecoveryPolicyMigration,
    "0004_queue_outcome_unknown": queueOutcomeUnknownMigration,
    "0005_better_auth": betterAuthMigration,
  }),
  table: "xpensego_migrations",
});

/** A migration identifier and name applied by one migration run. */
export type AppliedMigration = readonly [id: number, name: string];

/**
 * Apply all pending forward-only migrations through a scoped PostgreSQL client.
 *
 * @param databaseUrl - Redacted direct administrative PostgreSQL connection URL.
 * @returns The migrations applied by this invocation, in order.
 */
export function runMigrations(
  databaseUrl: Redacted.Redacted<string>,
): Effect.Effect<
  ReadonlyArray<AppliedMigration>,
  Migrator.MigrationError | import("@effect/sql/SqlError").SqlError
> {
  const sqlLayer = PgClient.layer({
    url: databaseUrl,
    applicationName: "xpensego-migrator",
    connectTimeout: "5 seconds",
    idleTimeout: "1 second",
    maxConnections: 1,
  });

  return migrationProgram.pipe(Effect.provide(sqlLayer), Effect.scoped);
}
