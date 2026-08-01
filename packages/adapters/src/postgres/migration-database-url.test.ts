import { Effect, Redacted } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { resolveMigrationDatabaseUrl } from "./migration-database-url.js";

const originalUrl = process.env.XPENSEGO_MIGRATION_DATABASE_URL;

afterEach(() => {
  if (originalUrl === undefined) {
    delete process.env.XPENSEGO_MIGRATION_DATABASE_URL;
  } else {
    process.env.XPENSEGO_MIGRATION_DATABASE_URL = originalUrl;
  }
});

describe("migration database URL", () => {
  it("redacts a credentialed PostgreSQL URL", async () => {
    process.env.XPENSEGO_MIGRATION_DATABASE_URL =
      "postgresql://migrator:secret@db.example.test/xpensego";

    const result = await Effect.runPromise(resolveMigrationDatabaseUrl());

    expect(Redacted.value(result)).toBe(process.env.XPENSEGO_MIGRATION_DATABASE_URL);
  });

  it("rejects an invalid URL with a safe typed startup error", async () => {
    process.env.XPENSEGO_MIGRATION_DATABASE_URL = "not-a-database-url";

    const result = await Effect.runPromise(resolveMigrationDatabaseUrl().pipe(Effect.either));

    expect(result).toMatchObject({
      _tag: "Left",
      left: expect.objectContaining({
        _tag: "InvalidMigrationDatabaseUrl",
        reason: "invalid_postgres_url",
      }),
    });
  });
});
