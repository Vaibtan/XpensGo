import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";

const localTestAdministrativeUrl =
  "postgresql://xpensego_migrator:xpensego_migration_local_only@127.0.0.1:55432/postgres";
const localTestRuntimeUrl =
  "postgresql://xpensego_runtime:xpensego_runtime_local_only@127.0.0.1:55432/postgres";

type IsolatedTestDatabaseName =
  | "xpensego_inbound_store_integration"
  | "xpensego_identity_store_integration"
  | "xpensego_migration_integration"
  | "xpensego_outbox_store_integration"
  | "xpensego_telegram_ingress_integration"
  | "xpensego_telegram_processing_integration"
  | "xpensego_telegram_delivery_integration"
  | "xpensego_worker_outbox_integration";

function parseLoopbackTestUrl(rawUrl: string, variableName: string): URL {
  let databaseUrl: URL;

  try {
    databaseUrl = new URL(rawUrl);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL`);
  }

  const isLoopback = ["127.0.0.1", "[::1]"].includes(databaseUrl.hostname);
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    !isLoopback ||
    databaseUrl.pathname !== "/postgres"
  ) {
    throw new Error(`${variableName} must target the loopback PostgreSQL postgres database`);
  }

  return databaseUrl;
}

function resolveTestDatabaseUrls(databaseName: IsolatedTestDatabaseName) {
  const administrativeUrl = parseLoopbackTestUrl(
    process.env.XPENSEGO_TEST_ADMIN_DATABASE_URL ?? localTestAdministrativeUrl,
    "XPENSEGO_TEST_ADMIN_DATABASE_URL",
  );
  const runtimeUrl = parseLoopbackTestUrl(
    process.env.XPENSEGO_TEST_RUNTIME_DATABASE_URL ?? localTestRuntimeUrl,
    "XPENSEGO_TEST_RUNTIME_DATABASE_URL",
  );
  const migrationUrl = new URL(administrativeUrl);
  const isolatedRuntimeUrl = new URL(runtimeUrl);
  migrationUrl.pathname = `/${databaseName}`;
  isolatedRuntimeUrl.pathname = `/${databaseName}`;

  return {
    administrative: Redacted.make(administrativeUrl.toString()),
    migration: Redacted.make(migrationUrl.toString()),
    runtime: Redacted.make(isolatedRuntimeUrl.toString()),
  } as const;
}

/**
 * Build lifecycle operations and redacted URLs for one disposable loopback-only database.
 *
 * @param databaseName - Allow-listed database name reserved for this integration suite.
 * @returns Explicit recreate/drop effects and migration/runtime connection URLs.
 */
export function makeIsolatedTestDatabase(databaseName: IsolatedTestDatabaseName) {
  const urls = resolveTestDatabaseUrls(databaseName);
  const administrativeClientLayer = PgClient.layer({
    url: urls.administrative,
    applicationName: "xpensego-isolated-test-database",
    maxConnections: 1,
  });

  const recreate = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP DATABASE IF EXISTS ${sql(databaseName)} WITH (FORCE)`;
    yield* sql`CREATE DATABASE ${sql(databaseName)}`;
  }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped);

  const drop = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP DATABASE IF EXISTS ${sql(databaseName)} WITH (FORCE)`;
  }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped);

  return {
    migrationUrl: urls.migration,
    runtimeUrl: urls.runtime,
    recreate,
    drop,
  } as const;
}
