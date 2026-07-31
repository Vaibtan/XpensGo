import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

/** Add recoverable publication leases and duplicate-safe Queue consumer receipts. */
export const outboxDispatchMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE outbox_messages
      ADD COLUMN publish_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN publish_claim_id UUID,
      ADD COLUMN publish_claimed_until TIMESTAMPTZ,
      ADD COLUMN next_publish_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN last_publish_error_code TEXT,
      ADD CONSTRAINT outbox_messages_publish_attempts_nonnegative
        CHECK (publish_attempts >= 0),
      ADD CONSTRAINT outbox_messages_publish_claim_complete
        CHECK (
          (publish_claim_id IS NULL AND publish_claimed_until IS NULL)
          OR (
            status = 'pending'
            AND publish_claim_id IS NOT NULL
            AND publish_claimed_until IS NOT NULL
          )
        ),
      ADD CONSTRAINT outbox_messages_publish_error_supported
        CHECK (
          last_publish_error_code IS NULL
          OR last_publish_error_code = 'queue_unavailable'
        )
  `;

  yield* sql`
    DROP INDEX outbox_messages_pending_order_idx
  `;

  yield* sql`
    CREATE INDEX outbox_messages_pending_order_idx
      ON outbox_messages (next_publish_attempt_at, created_at, id)
      WHERE status = 'pending'
  `;

  yield* sql`
    CREATE TABLE outbox_message_receipts (
      outbox_message_id UUID PRIMARY KEY
        REFERENCES outbox_messages(id)
        ON DELETE CASCADE,
      consumed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;

  yield* sql`
    GRANT UPDATE (
      status,
      published_at,
      publish_attempts,
      publish_claim_id,
      publish_claimed_until,
      next_publish_attempt_at,
      last_publish_error_code
    ) ON outbox_messages TO xpensego_runtime
  `;

  yield* sql`
    GRANT SELECT, INSERT ON outbox_message_receipts TO xpensego_runtime
  `;
});
