import { Redacted } from "effect";

const localMigrationDatabaseUrl =
  "postgresql://xpensego_migrator:xpensego_migration_local_only@127.0.0.1:55432/xpensego";

/** Resolve and immediately redact the migration connection URL. */
export function resolveMigrationDatabaseUrl(): Redacted.Redacted<string> {
  return Redacted.make(process.env.XPENSEGO_MIGRATION_DATABASE_URL ?? localMigrationDatabaseUrl);
}
