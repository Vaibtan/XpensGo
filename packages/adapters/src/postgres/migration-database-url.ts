import { Effect, Redacted, Schema } from "effect";

const localMigrationDatabaseUrl =
  "postgresql://xpensego_migrator:xpensego_migration_local_only@127.0.0.1:55432/xpensego";

/** Safe startup failure for a missing or malformed privileged migration URL. */
export class InvalidMigrationDatabaseUrl extends Schema.TaggedError<InvalidMigrationDatabaseUrl>()(
  "InvalidMigrationDatabaseUrl",
  {
    reason: Schema.Literal("invalid_postgres_url"),
  },
) {
  override get message(): string {
    return "The migration database URL is not a valid credentialed PostgreSQL URL.";
  }
}

/** Parse and immediately redact the privileged migration connection URL. */
export function resolveMigrationDatabaseUrl(): Effect.Effect<
  Redacted.Redacted<string>,
  InvalidMigrationDatabaseUrl
> {
  const candidate = process.env.XPENSEGO_MIGRATION_DATABASE_URL ?? localMigrationDatabaseUrl;

  return Effect.try({
    try: () => {
      const parsed = new URL(candidate);
      if (
        !["postgres:", "postgresql:"].includes(parsed.protocol) ||
        parsed.hostname.length === 0 ||
        parsed.username.length === 0 ||
        parsed.password.length === 0 ||
        parsed.pathname === "/"
      ) {
        throw new Error("invalid PostgreSQL URL shape");
      }
      return Redacted.make(candidate);
    },
    catch: () => new InvalidMigrationDatabaseUrl({ reason: "invalid_postgres_url" }),
  });
}
