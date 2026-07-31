import { Migrator } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { Effect, type Redacted } from "effect";

import { foundationMigration } from "./migrations/0001-foundation.js";

const migrationProgram = Migrator.make({})({
  loader: Migrator.fromRecord({
    "0001_foundation": foundationMigration,
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
