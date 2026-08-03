import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

/** Add auditable, idempotent operator recovery records for explicit Telegram rejections. */
export const telegramDeliveryRecoveryMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE outbox_messages
      ADD CONSTRAINT outbox_messages_id_outbound_unique UNIQUE (id, outbound_message_id)
  `;

  yield* sql`
    CREATE TABLE telegram_delivery_recoveries (
      id TEXT PRIMARY KEY,
      outbound_message_id UUID NOT NULL
        REFERENCES outbound_channel_messages (id) ON DELETE CASCADE,
      outbox_message_id UUID NOT NULL,
      correlation_id UUID NOT NULL,
      expected_error_code TEXT NOT NULL,
      reason TEXT NOT NULL,
      publication_status TEXT NOT NULL DEFAULT 'prepared',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      published_at TIMESTAMPTZ,
      CONSTRAINT telegram_delivery_recoveries_id_bounded
        CHECK (
          char_length(id) BETWEEN 1 AND 128
          AND id ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'
        ),
      CONSTRAINT telegram_delivery_recoveries_outbox_matches_message
        FOREIGN KEY (outbox_message_id, outbound_message_id)
        REFERENCES outbox_messages (id, outbound_message_id)
        ON DELETE CASCADE,
      CONSTRAINT telegram_delivery_recoveries_error_code_bounded
        CHECK (
          char_length(expected_error_code) BETWEEN 1 AND 64
          AND expected_error_code ~ '^[a-z0-9_]+$'
        ),
      CONSTRAINT telegram_delivery_recoveries_reason_supported
        CHECK (reason IN ('recipient_state_corrected', 'provider_configuration_corrected')),
      CONSTRAINT telegram_delivery_recoveries_publication_status_supported
        CHECK (publication_status IN ('prepared', 'published')),
      CONSTRAINT telegram_delivery_recoveries_publication_state_complete
        CHECK (
          (publication_status = 'prepared' AND published_at IS NULL)
          OR (publication_status = 'published' AND published_at IS NOT NULL)
        )
    )
  `;

  yield* sql`
    CREATE INDEX telegram_delivery_recoveries_message_created_idx
      ON telegram_delivery_recoveries (outbound_message_id, created_at)
  `;
});
