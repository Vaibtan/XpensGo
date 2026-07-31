import { NodeRuntime } from "@effect/platform-node";
import { Effect, Schema } from "effect";

import { resolveMigrationDatabaseUrl } from "./migration-database-url.js";
import { runMigrations } from "./migrations.js";

class MigrationCommandFailed extends Schema.TaggedError<MigrationCommandFailed>()(
  "MigrationCommandFailed",
  {
    errorTag: Schema.String,
  },
) {
  override get message(): string {
    return `PostgreSQL migration failed with ${this.errorTag}.`;
  }
}

const databaseUrl = resolveMigrationDatabaseUrl();

const program = runMigrations(databaseUrl).pipe(
  Effect.tap((applied) =>
    Effect.logInfo("PostgreSQL migrations complete", {
      appliedCount: applied.length,
    }),
  ),
  Effect.asVoid,
  Effect.mapError((error) => new MigrationCommandFailed({ errorTag: error._tag })),
);

NodeRuntime.runMain(program);
