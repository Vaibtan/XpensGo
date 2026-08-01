import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

/** Install the Better Auth v1.6.25 schema without granting runtime DDL authority. */
export const betterAuthMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE auth_user (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      "emailVerified" BOOLEAN NOT NULL,
      image TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  yield* sql`
    CREATE TABLE auth_session (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "expiresAt" TIMESTAMPTZ NOT NULL,
      token TEXT NOT NULL UNIQUE,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMPTZ NOT NULL,
      "ipAddress" TEXT,
      "userAgent" TEXT,
      "userId" UUID NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE TABLE auth_account (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "accountId" TEXT NOT NULL,
      "providerId" TEXT NOT NULL,
      "userId" UUID NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
      "accessToken" TEXT,
      "refreshToken" TEXT,
      "idToken" TEXT,
      "accessTokenExpiresAt" TIMESTAMPTZ,
      "refreshTokenExpiresAt" TIMESTAMPTZ,
      scope TEXT,
      password TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMPTZ NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE auth_verification (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      "expiresAt" TIMESTAMPTZ NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  yield* sql`
    CREATE TABLE "rateLimit" (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      key TEXT NOT NULL UNIQUE,
      count INTEGER NOT NULL,
      "lastRequest" BIGINT NOT NULL
    )
  `;

  yield* sql`CREATE INDEX auth_session_user_id_idx ON auth_session ("userId")`;
  yield* sql`CREATE INDEX auth_account_user_id_idx ON auth_account ("userId")`;
  yield* sql`CREATE INDEX auth_verification_identifier_idx ON auth_verification (identifier)`;

  yield* sql`
    GRANT SELECT, INSERT, UPDATE, DELETE
    ON auth_user, auth_session, auth_account, auth_verification, "rateLimit"
    TO xpensego_runtime
  `;
});
