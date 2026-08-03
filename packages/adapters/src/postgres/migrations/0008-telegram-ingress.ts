import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

/** Permit ownerless verified Telegram ingress while retaining explicit scope once resolved. */
export const telegramIngressMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE inbound_channel_events
      ALTER COLUMN owner_user_id DROP NOT NULL,
      ALTER COLUMN ledger_id DROP NOT NULL,
      ADD COLUMN normalized_payload JSONB,
      ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'pending',
      ADD COLUMN processing_outcome TEXT,
      ADD COLUMN processed_at TIMESTAMPTZ,
      ADD CONSTRAINT inbound_channel_events_scope_complete
        CHECK (
          (owner_user_id IS NULL AND ledger_id IS NULL)
          OR (owner_user_id IS NOT NULL AND ledger_id IS NOT NULL)
        ),
      ADD CONSTRAINT inbound_channel_events_normalized_payload_object
        CHECK (
          normalized_payload IS NULL
          OR jsonb_typeof(normalized_payload) = 'object'
        ),
      ADD CONSTRAINT inbound_channel_events_processing_status_supported
        CHECK (processing_status IN ('pending', 'processed', 'suppressed')),
      ADD CONSTRAINT inbound_channel_events_processing_state_complete
        CHECK (
          (processing_status = 'pending' AND processed_at IS NULL)
          OR (processing_status IN ('processed', 'suppressed') AND processed_at IS NOT NULL)
        )
  `;

  yield* sql`
    UPDATE inbound_channel_events
    SET
      processing_status = 'processed',
      processing_outcome = 'legacy_accepted',
      processed_at = received_at
    WHERE normalized_payload IS NULL
  `;

  yield* sql`
    ALTER TABLE outbox_messages
      ALTER COLUMN owner_user_id DROP NOT NULL,
      ALTER COLUMN ledger_id DROP NOT NULL,
      DROP CONSTRAINT outbox_messages_inbound_event_unique,
      ADD CONSTRAINT outbox_messages_scope_complete
        CHECK (
          (owner_user_id IS NULL AND ledger_id IS NULL)
          OR (owner_user_id IS NOT NULL AND ledger_id IS NOT NULL)
        ),
      ADD CONSTRAINT outbox_messages_inbound_kind_unique
        UNIQUE (inbound_event_id, kind)
  `;
});
