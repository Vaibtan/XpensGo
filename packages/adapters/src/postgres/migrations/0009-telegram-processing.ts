import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

/** Add durable Telegram processing, abuse, reply, and provider-attempt state. */
export const telegramProcessingMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE inbound_channel_events
      DROP CONSTRAINT inbound_channel_events_processing_status_supported,
      DROP CONSTRAINT inbound_channel_events_processing_state_complete,
      ADD COLUMN processing_claim_id UUID,
      ADD COLUMN processing_claimed_until TIMESTAMPTZ,
      ADD COLUMN processing_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN abuse_checked_at TIMESTAMPTZ,
      ADD COLUMN abuse_allowed BOOLEAN,
      ADD COLUMN user_abuse_checked_at TIMESTAMPTZ,
      ADD COLUMN user_abuse_allowed BOOLEAN,
      ADD CONSTRAINT inbound_channel_events_processing_status_supported
        CHECK (processing_status IN ('pending', 'processing', 'processed', 'suppressed')),
      ADD CONSTRAINT inbound_channel_events_processing_attempts_nonnegative
        CHECK (processing_attempts >= 0),
      ADD CONSTRAINT inbound_channel_events_processing_claim_complete
        CHECK (
          (processing_claim_id IS NULL AND processing_claimed_until IS NULL)
          OR (
            processing_status = 'processing'
            AND processing_claim_id IS NOT NULL
            AND processing_claimed_until IS NOT NULL
          )
        ),
      ADD CONSTRAINT inbound_channel_events_abuse_decision_complete
        CHECK (
          (abuse_checked_at IS NULL AND abuse_allowed IS NULL)
          OR (abuse_checked_at IS NOT NULL AND abuse_allowed IS NOT NULL)
        ),
      ADD CONSTRAINT inbound_channel_events_user_abuse_decision_complete
        CHECK (
          (user_abuse_checked_at IS NULL AND user_abuse_allowed IS NULL)
          OR (user_abuse_checked_at IS NOT NULL AND user_abuse_allowed IS NOT NULL)
        ),
      ADD CONSTRAINT inbound_channel_events_processing_state_complete
        CHECK (
          (
            processing_status = 'pending'
            AND processing_claim_id IS NULL
            AND processed_at IS NULL
          )
          OR (
            processing_status = 'processing'
            AND processing_claim_id IS NOT NULL
            AND processed_at IS NULL
          )
          OR (
            processing_status IN ('processed', 'suppressed')
            AND processing_claim_id IS NULL
            AND processed_at IS NOT NULL
          )
        )
  `;

  yield* sql`
    CREATE TABLE channel_abuse_windows (
      channel TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      window_started_at TIMESTAMPTZ NOT NULL,
      event_count INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (channel, scope_type, scope_key, window_started_at),
      CONSTRAINT channel_abuse_windows_channel_supported CHECK (channel = 'telegram'),
      CONSTRAINT channel_abuse_windows_scope_supported
        CHECK (scope_type IN ('system', 'identity', 'user')),
      CONSTRAINT channel_abuse_windows_count_positive CHECK (event_count > 0)
    )
  `;

  yield* sql`
    CREATE TABLE normalized_channel_commands (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      inbound_event_id UUID NOT NULL UNIQUE
        REFERENCES inbound_channel_events (id) ON DELETE CASCADE,
      owner_user_id UUID NOT NULL,
      ledger_id UUID NOT NULL,
      channel_identity_id UUID NOT NULL,
      channel TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      command_text TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      correlation_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT normalized_channel_commands_channel_supported CHECK (channel = 'telegram'),
      CONSTRAINT normalized_channel_commands_text_bounded
        CHECK (char_length(command_text) BETWEEN 1 AND 4096),
      CONSTRAINT normalized_channel_commands_event_owner_fk
        FOREIGN KEY (inbound_event_id, ledger_id, owner_user_id)
        REFERENCES inbound_channel_events (id, ledger_id, owner_user_id)
        ON DELETE CASCADE,
      CONSTRAINT normalized_channel_commands_identity_owner_fk
        FOREIGN KEY (channel_identity_id, owner_user_id, ledger_id)
        REFERENCES channel_identities (id, user_id, ledger_id)
        ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE TABLE outbound_channel_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      inbound_event_id UUID NOT NULL UNIQUE
        REFERENCES inbound_channel_events (id) ON DELETE CASCADE,
      owner_user_id UUID,
      ledger_id UUID,
      channel_identity_id UUID,
      channel TEXT NOT NULL,
      external_conversation_id TEXT NOT NULL,
      intent JSONB NOT NULL,
      correlation_id UUID NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      delivery_claim_id UUID,
      delivery_claimed_until TIMESTAMPTZ,
      provider_message_id TEXT,
      last_error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      provider_accepted_at TIMESTAMPTZ,
      terminal_at TIMESTAMPTZ,
      CONSTRAINT outbound_channel_messages_channel_supported CHECK (channel = 'telegram'),
      CONSTRAINT outbound_channel_messages_conversation_nonempty
        CHECK (char_length(external_conversation_id) BETWEEN 1 AND 32),
      CONSTRAINT outbound_channel_messages_intent_object
        CHECK (jsonb_typeof(intent) = 'object'),
      CONSTRAINT outbound_channel_messages_scope_complete
        CHECK (
          (owner_user_id IS NULL AND ledger_id IS NULL AND channel_identity_id IS NULL)
          OR (
            owner_user_id IS NOT NULL
            AND ledger_id IS NOT NULL
            AND channel_identity_id IS NOT NULL
          )
        ),
      CONSTRAINT outbound_channel_messages_status_supported
        CHECK (
          status IN (
            'pending',
            'delivering',
            'provider_accepted',
            'terminal_failure',
            'outcome_unknown'
          )
        ),
      CONSTRAINT outbound_channel_messages_attempts_nonnegative CHECK (delivery_attempts >= 0),
      CONSTRAINT outbound_channel_messages_claim_complete
        CHECK (
          (delivery_claim_id IS NULL AND delivery_claimed_until IS NULL)
          OR (
            status = 'delivering'
            AND delivery_claim_id IS NOT NULL
            AND delivery_claimed_until IS NOT NULL
          )
        ),
      CONSTRAINT outbound_channel_messages_terminal_state_complete
        CHECK (
          (status = 'pending' AND provider_accepted_at IS NULL AND terminal_at IS NULL)
          OR (status = 'delivering' AND provider_accepted_at IS NULL AND terminal_at IS NULL)
          OR (
            status = 'provider_accepted'
            AND provider_accepted_at IS NOT NULL
            AND terminal_at IS NULL
            AND provider_message_id IS NOT NULL
          )
          OR (
            status IN ('terminal_failure', 'outcome_unknown')
            AND provider_accepted_at IS NULL
            AND terminal_at IS NOT NULL
          )
        ),
      CONSTRAINT outbound_channel_messages_event_owner_fk
        FOREIGN KEY (inbound_event_id, ledger_id, owner_user_id)
        REFERENCES inbound_channel_events (id, ledger_id, owner_user_id)
        ON DELETE CASCADE,
      CONSTRAINT outbound_channel_messages_identity_owner_fk
        FOREIGN KEY (channel_identity_id, owner_user_id, ledger_id)
        REFERENCES channel_identities (id, user_id, ledger_id)
        ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE TABLE channel_delivery_attempts (
      id UUID PRIMARY KEY,
      outbound_message_id UUID NOT NULL
        REFERENCES outbound_channel_messages (id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      provider_message_id TEXT,
      error_code TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMPTZ,
      CONSTRAINT channel_delivery_attempts_number_positive CHECK (attempt_number > 0),
      CONSTRAINT channel_delivery_attempts_status_supported
        CHECK (
          status IN (
            'attempting',
            'provider_accepted',
            'transient_failure',
            'terminal_failure',
            'outcome_unknown'
          )
        ),
      CONSTRAINT channel_delivery_attempts_completion_state
        CHECK (
          (status = 'attempting' AND completed_at IS NULL)
          OR (status <> 'attempting' AND completed_at IS NOT NULL)
        ),
      CONSTRAINT channel_delivery_attempts_number_unique
        UNIQUE (outbound_message_id, attempt_number)
    )
  `;

  yield* sql`
    ALTER TABLE outbox_messages
      DROP CONSTRAINT outbox_messages_kind_supported,
      ADD COLUMN outbound_message_id UUID
        REFERENCES outbound_channel_messages (id) ON DELETE CASCADE,
      ADD CONSTRAINT outbox_messages_kind_supported
        CHECK (kind IN ('channel.event.received.v1', 'channel.reply.requested.v1')),
      ADD CONSTRAINT outbox_messages_target_matches_kind
        CHECK (
          (kind = 'channel.event.received.v1' AND outbound_message_id IS NULL)
          OR (kind = 'channel.reply.requested.v1' AND outbound_message_id IS NOT NULL)
        )
  `;

  yield* sql`
    CREATE INDEX outbound_channel_messages_pending_idx
      ON outbound_channel_messages (created_at, id)
      WHERE status = 'pending'
  `;

  yield* sql`
    GRANT SELECT, INSERT, UPDATE ON channel_abuse_windows TO xpensego_runtime
  `;

  yield* sql`
    GRANT SELECT, INSERT ON normalized_channel_commands, outbound_channel_messages,
      channel_delivery_attempts TO xpensego_runtime
  `;

  yield* sql`
    GRANT UPDATE (
      owner_user_id,
      ledger_id,
      processing_status,
      processing_outcome,
      processed_at,
      processing_claim_id,
      processing_claimed_until,
      processing_attempts,
      abuse_checked_at,
      abuse_allowed,
      user_abuse_checked_at,
      user_abuse_allowed
    ) ON inbound_channel_events TO xpensego_runtime
  `;

  yield* sql`
    GRANT UPDATE (
      status,
      delivery_attempts,
      delivery_claim_id,
      delivery_claimed_until,
      provider_message_id,
      last_error_code,
      provider_accepted_at,
      terminal_at
    ) ON outbound_channel_messages TO xpensego_runtime
  `;

  yield* sql`
    GRANT UPDATE (
      status,
      provider_message_id,
      error_code,
      completed_at
    ) ON channel_delivery_attempts TO xpensego_runtime
  `;
});
