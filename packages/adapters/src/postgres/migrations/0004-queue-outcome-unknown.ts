import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

/** Preserve a distinct durable state when Queue acceptance cannot be determined. */
export const queueOutcomeUnknownMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE outbox_messages
      DROP CONSTRAINT outbox_messages_publish_error_supported,
      ADD CONSTRAINT outbox_messages_publish_error_supported
        CHECK (
          last_publish_error_code IS NULL
          OR last_publish_error_code IN (
            'consumer_stalled',
            'publication_attempts_exhausted',
            'queue_outcome_unknown',
            'queue_unavailable'
          )
        )
  `;
});
