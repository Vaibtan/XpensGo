import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

/** Record every Queue delivery attempt without weakening the unique consumer receipt. */
export const outboxConsumptionObservabilityMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE outbox_message_receipts
      ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN last_delivered_at TIMESTAMPTZ
  `;

  yield* sql`
    UPDATE outbox_message_receipts
    SET last_delivered_at = consumed_at
  `;

  yield* sql`
    ALTER TABLE outbox_message_receipts
      ALTER COLUMN last_delivered_at SET NOT NULL,
      ALTER COLUMN last_delivered_at SET DEFAULT CURRENT_TIMESTAMP,
      ADD CONSTRAINT outbox_message_receipts_delivery_attempts_positive
        CHECK (delivery_attempts > 0)
  `;

  yield* sql`
    GRANT UPDATE (delivery_attempts, last_delivered_at)
    ON outbox_message_receipts TO xpensego_runtime
  `;
});
