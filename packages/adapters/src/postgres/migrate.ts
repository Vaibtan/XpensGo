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

const program = Effect.gen(function* () {
  const databaseUrl = yield* resolveMigrationDatabaseUrl();
  const applied = yield* runMigrations(databaseUrl);
  yield* Effect.logInfo("PostgreSQL migrations complete", {
    appliedCount: applied.length,
  });
}).pipe(
  Effect.asVoid,
  Effect.mapError((error) => new MigrationCommandFailed({ errorTag: error._tag })),
);

NodeRuntime.runMain(program);
