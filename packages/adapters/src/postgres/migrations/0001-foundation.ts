import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

/** Establish the minimal ownership, inbound-idempotency, and outbox schema. */
export const foundationMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    REVOKE CREATE ON SCHEMA public FROM PUBLIC
  `;

  yield* sql`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  yield* sql`
    CREATE TABLE ledgers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT ledgers_one_personal_ledger_per_owner UNIQUE (owner_user_id),
      CONSTRAINT ledgers_id_owner_unique UNIQUE (id, owner_user_id)
    )
  `;

  yield* sql`
    CREATE TABLE inbound_channel_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id UUID NOT NULL,
      ledger_id UUID NOT NULL,
      channel TEXT NOT NULL,
      external_event_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      correlation_id UUID NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT inbound_channel_events_channel_supported
        CHECK (channel IN ('telegram', 'whatsapp')),
      CONSTRAINT inbound_channel_events_external_id_nonempty
        CHECK (char_length(external_event_id) BETWEEN 1 AND 256),
      CONSTRAINT inbound_channel_events_idempotency_key_nonempty
        CHECK (char_length(idempotency_key) BETWEEN 1 AND 320),
      CONSTRAINT inbound_channel_events_ledger_owner_fk
        FOREIGN KEY (ledger_id, owner_user_id)
        REFERENCES ledgers(id, owner_user_id)
        ON DELETE CASCADE,
      CONSTRAINT inbound_channel_events_provider_event_unique
        UNIQUE (channel, external_event_id),
      CONSTRAINT inbound_channel_events_idempotency_key_unique
        UNIQUE (idempotency_key),
      CONSTRAINT inbound_channel_events_id_ledger_owner_unique
        UNIQUE (id, ledger_id, owner_user_id)
    )
  `;

  yield* sql`
    CREATE TABLE outbox_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      inbound_event_id UUID NOT NULL,
      owner_user_id UUID NOT NULL,
      ledger_id UUID NOT NULL,
      kind TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      published_at TIMESTAMPTZ,
      CONSTRAINT outbox_messages_inbound_event_unique UNIQUE (inbound_event_id),
      CONSTRAINT outbox_messages_kind_supported
        CHECK (kind = 'channel.event.received.v1'),
      CONSTRAINT outbox_messages_payload_object
        CHECK (jsonb_typeof(payload) = 'object'),
      CONSTRAINT outbox_messages_status_supported
        CHECK (status IN ('pending', 'published')),
      CONSTRAINT outbox_messages_publication_state
        CHECK (
          (status = 'pending' AND published_at IS NULL)
          OR (status = 'published' AND published_at IS NOT NULL)
        ),
      CONSTRAINT outbox_messages_inbound_owner_fk
        FOREIGN KEY (inbound_event_id, ledger_id, owner_user_id)
        REFERENCES inbound_channel_events(id, ledger_id, owner_user_id)
        ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX outbox_messages_pending_order_idx
      ON outbox_messages (created_at, id)
      WHERE status = 'pending'
  `;

  yield* sql`
    GRANT USAGE ON SCHEMA public TO xpensego_runtime
  `;

  yield* sql`
    GRANT SELECT, INSERT ON inbound_channel_events TO xpensego_runtime
  `;

  yield* sql`
    GRANT SELECT, INSERT ON outbox_messages TO xpensego_runtime
  `;
});
