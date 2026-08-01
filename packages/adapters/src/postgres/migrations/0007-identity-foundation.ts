import { SqlClient } from "@effect/sql";
import { DEFAULT_CATEGORIES } from "@xpensego/domain/category/default-categories";
import { Effect } from "effect";

/** Add application-owned account, timezone, Category, and Telegram-linking records. */
export const identityFoundationMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE users
      ADD COLUMN auth_user_id UUID
        REFERENCES auth_user (id) ON DELETE RESTRICT,
      ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      ADD CONSTRAINT users_auth_user_unique UNIQUE (auth_user_id),
      ADD CONSTRAINT users_timezone_nonempty
        CHECK (char_length(timezone) BETWEEN 1 AND 64 AND timezone = btrim(timezone))
  `;

  yield* sql`
    CREATE TABLE categories (
      id UUID PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      is_fallback BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT categories_key_format
        CHECK (key ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$' AND char_length(key) <= 64),
      CONSTRAINT categories_label_nonempty
        CHECK (char_length(label) BETWEEN 1 AND 80 AND label = btrim(label))
    )
  `;

  for (const category of DEFAULT_CATEGORIES) {
    yield* sql`
      INSERT INTO categories (id, key, label, is_fallback)
      VALUES (${category.id}, ${category.key}, ${category.label}, ${category.isFallback})
    `;
  }

  yield* sql`
    CREATE UNIQUE INDEX categories_single_fallback_idx
      ON categories (is_fallback)
      WHERE is_fallback
  `;

  yield* sql`
    CREATE TABLE channel_identities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      ledger_id UUID NOT NULL,
      channel TEXT NOT NULL,
      external_account_id TEXT NOT NULL,
      linked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      unlinked_at TIMESTAMPTZ,
      CONSTRAINT channel_identities_channel_supported CHECK (channel = 'telegram'),
      CONSTRAINT channel_identities_external_account_nonempty
        CHECK (char_length(external_account_id) BETWEEN 1 AND 32),
      CONSTRAINT channel_identities_unlink_order
        CHECK (unlinked_at IS NULL OR unlinked_at >= linked_at),
      CONSTRAINT channel_identities_ledger_owner_fk
        FOREIGN KEY (ledger_id, user_id)
        REFERENCES ledgers (id, owner_user_id)
        ON DELETE CASCADE,
      CONSTRAINT channel_identities_id_owner_unique UNIQUE (id, user_id, ledger_id)
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX channel_identities_active_external_unique
      ON channel_identities (channel, external_account_id)
      WHERE unlinked_at IS NULL
  `;

  yield* sql`
    CREATE INDEX channel_identities_active_user_idx
      ON channel_identities (user_id, linked_at, id)
      WHERE unlinked_at IS NULL
  `;

  yield* sql`
    CREATE TABLE channel_link_challenges (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      ledger_id UUID NOT NULL,
      channel TEXT NOT NULL,
      purpose TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      target_channel_identity_id UUID,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      CONSTRAINT channel_link_challenges_channel_supported CHECK (channel = 'telegram'),
      CONSTRAINT channel_link_challenges_purpose_supported
        CHECK (purpose IN ('link', 'unlink')),
      CONSTRAINT channel_link_challenges_token_hash_format
        CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT channel_link_challenges_expiry_order CHECK (expires_at > created_at),
      CONSTRAINT channel_link_challenges_consumption_order
        CHECK (consumed_at IS NULL OR consumed_at >= created_at),
      CONSTRAINT channel_link_challenges_target_matches_purpose
        CHECK (
          (purpose = 'link' AND target_channel_identity_id IS NULL)
          OR (purpose = 'unlink' AND target_channel_identity_id IS NOT NULL)
        ),
      CONSTRAINT channel_link_challenges_ledger_owner_fk
        FOREIGN KEY (ledger_id, user_id)
        REFERENCES ledgers (id, owner_user_id)
        ON DELETE CASCADE,
      CONSTRAINT channel_link_challenges_target_owner_fk
        FOREIGN KEY (target_channel_identity_id, user_id, ledger_id)
        REFERENCES channel_identities (id, user_id, ledger_id)
        ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX channel_link_challenges_rate_limit_idx
      ON channel_link_challenges (user_id, created_at DESC)
  `;

  yield* sql`
    CREATE INDEX channel_link_challenges_target_idx
      ON channel_link_challenges (target_channel_identity_id)
      WHERE target_channel_identity_id IS NOT NULL
  `;

  yield* sql`
    GRANT SELECT, INSERT ON users, ledgers, channel_identities, channel_link_challenges
    TO xpensego_runtime
  `;

  yield* sql`
    GRANT SELECT ON categories TO xpensego_runtime
  `;

  yield* sql`
    GRANT UPDATE (timezone) ON users TO xpensego_runtime
  `;

  yield* sql`
    GRANT UPDATE (unlinked_at) ON channel_identities TO xpensego_runtime
  `;

  yield* sql`
    GRANT UPDATE (consumed_at) ON channel_link_challenges TO xpensego_runtime
  `;
});
