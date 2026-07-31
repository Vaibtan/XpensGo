import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

/** Add terminal publication state and stalled-consumer reconciliation metadata. */
export const outboxRecoveryPolicyMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE outbox_messages
      ADD COLUMN failed_at TIMESTAMPTZ,
      DROP CONSTRAINT outbox_messages_publish_error_supported,
      DROP CONSTRAINT outbox_messages_status_supported,
      DROP CONSTRAINT outbox_messages_publication_state,
      ADD CONSTRAINT outbox_messages_publish_error_supported
        CHECK (
          last_publish_error_code IS NULL
          OR last_publish_error_code IN (
            'consumer_stalled',
            'publication_attempts_exhausted',
            'queue_unavailable'
          )
        ),
      ADD CONSTRAINT outbox_messages_status_supported
        CHECK (status IN ('pending', 'published', 'failed')),
      ADD CONSTRAINT outbox_messages_publication_state
        CHECK (
          (
            status = 'pending'
            AND published_at IS NULL
            AND failed_at IS NULL
          )
          OR (
            status = 'published'
            AND published_at IS NOT NULL
            AND failed_at IS NULL
          )
          OR (
            status = 'failed'
            AND published_at IS NULL
            AND failed_at IS NOT NULL
            AND last_publish_error_code IS NOT NULL
          )
        )
  `;

  yield* sql`
    GRANT UPDATE (failed_at) ON outbox_messages TO xpensego_runtime
  `;
});
