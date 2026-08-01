import { PgClient } from "@effect/sql-pg";
import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import {
  OutboxClaimId,
  OutboxPublicationAttempt,
  OutboxPersistence,
  OutboxPersistenceUnavailable,
  OutboxPublicationStateConflict,
  OutboxRecovery,
  type OutboxPersistenceService,
  type OutboxRecoveryService,
} from "@xpensego/domain/outbox/outbox-delivery";
import { Effect, Layer, Schema, type Redacted } from "effect";

const ClaimedOutboxPublicationRow = Schema.Struct({
  outboxMessageId: OutboxMessageId,
  claimId: OutboxClaimId,
  correlationId: CorrelationId,
  attempt: OutboxPublicationAttempt,
});

const UpdatedOutboxMessageRow = Schema.Struct({
  outboxMessageId: OutboxMessageId,
});

const OutboxPublicationStateRow = Schema.Struct({
  status: Schema.Literal("pending", "published", "failed"),
});

const OutboxConsumptionRow = Schema.Struct({
  outboxExists: Schema.Boolean,
  receiptInserted: Schema.Boolean,
});

function persistenceUnavailable(
  operation: OutboxPersistenceUnavailable["operation"],
): OutboxPersistenceUnavailable {
  return new OutboxPersistenceUnavailable({ operation, reason: "database_unavailable" });
}

function observePersistenceFailure(
  operation: OutboxPersistenceUnavailable["operation"],
  cause: unknown,
) {
  return Effect.logWarning("PostgreSQL outbox operation failed", {
    operation,
    causeTag: cause instanceof Error ? cause.name : "UnknownFailure",
  });
}

/** PostgreSQL outbox persistence implementation that requires an already-scoped client. */
export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;

  const resolveClaimTransition = Effect.fn("PostgresOutboxPersistence.resolveClaimTransition")(
    function* (input: {
      readonly operation: OutboxPublicationStateConflict["operation"];
      readonly outboxMessageId: typeof OutboxMessageId.Type;
      readonly updatedRows: ReadonlyArray<{ readonly outboxMessageId: unknown }>;
    }) {
      if (input.updatedRows.length > 0) {
        yield* Schema.decodeUnknown(UpdatedOutboxMessageRow)(input.updatedRows[0]);
        return;
      }

      const stateRows = yield* sql<{ readonly status: unknown }>`
        SELECT status
        FROM outbox_messages
        WHERE id = ${input.outboxMessageId}
      `;
      const state = yield* Schema.decodeUnknown(OutboxPublicationStateRow)(stateRows[0]);

      if (state.status !== "published") {
        return yield* new OutboxPublicationStateConflict({
          operation: input.operation,
          outboxMessageId: input.outboxMessageId,
        });
      }
    },
  );

  const claimPending: OutboxPersistenceService["claimPending"] = Effect.fn(
    "PostgresOutboxPersistence.claimPending",
  )(function* (input) {
    const transaction = Effect.gen(function* () {
      yield* sql`
        UPDATE outbox_messages AS message
        SET
          status = 'published',
          published_at = receipt.consumed_at,
          failed_at = NULL,
          publish_claim_id = NULL,
          publish_claimed_until = NULL,
          last_publish_error_code = NULL
        FROM outbox_message_receipts AS receipt
        WHERE receipt.outbox_message_id = message.id
          AND message.status <> 'published'
      `;

      yield* sql`
        UPDATE outbox_messages AS message
        SET
          status = CASE
            WHEN publish_attempts >= ${input.maximumAttempts} THEN 'failed'
            ELSE 'pending'
          END,
          published_at = NULL,
          failed_at = CASE
            WHEN publish_attempts >= ${input.maximumAttempts} THEN CURRENT_TIMESTAMP
            ELSE NULL
          END,
          next_publish_attempt_at = CURRENT_TIMESTAMP,
          publish_claim_id = NULL,
          publish_claimed_until = NULL,
          last_publish_error_code = 'consumer_stalled'
        WHERE message.status = 'published'
          AND message.published_at <= CURRENT_TIMESTAMP
            - (${input.receiptTimeoutSeconds} * INTERVAL '1 second')
          AND NOT EXISTS (
            SELECT 1
            FROM outbox_message_receipts AS receipt
            WHERE receipt.outbox_message_id = message.id
          )
      `;

      yield* sql`
        UPDATE outbox_messages
        SET
          status = 'failed',
          failed_at = CURRENT_TIMESTAMP,
          publish_claim_id = NULL,
          publish_claimed_until = NULL,
          last_publish_error_code = 'publication_attempts_exhausted'
        WHERE status = 'pending'
          AND publish_attempts >= ${input.maximumAttempts}
          AND (
            publish_claimed_until IS NULL
            OR publish_claimed_until <= CURRENT_TIMESTAMP
          )
      `;

      const rows = yield* sql<{
        readonly outboxMessageId: unknown;
        readonly claimId: unknown;
        readonly correlationId: unknown;
        readonly attempt: unknown;
      }>`
        WITH candidates AS (
          SELECT id
          FROM outbox_messages
          WHERE status = 'pending'
            AND publish_attempts < ${input.maximumAttempts}
            AND next_publish_attempt_at <= CURRENT_TIMESTAMP
            AND (
              publish_claimed_until IS NULL
              OR publish_claimed_until <= CURRENT_TIMESTAMP
            )
          ORDER BY next_publish_attempt_at, created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT ${input.limit}
        )
        UPDATE outbox_messages AS message
        SET
          publish_claim_id = gen_random_uuid(),
          publish_claimed_until = CURRENT_TIMESTAMP
            + (${input.leaseDurationSeconds} * INTERVAL '1 second'),
          publish_attempts = publish_attempts + 1
        FROM candidates
        WHERE message.id = candidates.id
        RETURNING
          message.id AS "outboxMessageId",
          message.publish_claim_id AS "claimId",
          message.payload ->> 'correlationId' AS "correlationId",
          message.publish_attempts AS "attempt"
      `;

      return yield* Schema.decodeUnknown(Schema.Array(ClaimedOutboxPublicationRow))(rows);
    });

    return yield* sql.withTransaction(transaction).pipe(
      Effect.tapError((cause) => observePersistenceFailure("claimPendingOutbox", cause)),
      Effect.mapError(() => persistenceUnavailable("claimPendingOutbox")),
    );
  });

  const markPublished: OutboxPersistenceService["markPublished"] = Effect.fn(
    "PostgresOutboxPersistence.markPublished",
  )(function* (input) {
    const operation = Effect.gen(function* () {
      const updatedRows = yield* sql<{ readonly outboxMessageId: unknown }>`
        UPDATE outbox_messages
        SET
          status = 'published',
          published_at = CURRENT_TIMESTAMP,
          publish_claim_id = NULL,
          publish_claimed_until = NULL,
          last_publish_error_code = NULL
        WHERE id = ${input.outboxMessageId}
          AND status = 'pending'
          AND publish_claim_id = ${input.claimId}
        RETURNING id AS "outboxMessageId"
      `;

      yield* resolveClaimTransition({
        operation: "markOutboxPublished",
        outboxMessageId: input.outboxMessageId,
        updatedRows,
      });
    });

    return yield* operation.pipe(
      Effect.tapError((cause) =>
        cause instanceof OutboxPublicationStateConflict
          ? Effect.void
          : observePersistenceFailure("markOutboxPublished", cause),
      ),
      Effect.mapError((cause) =>
        cause instanceof OutboxPublicationStateConflict
          ? cause
          : persistenceUnavailable("markOutboxPublished"),
      ),
    );
  });

  const recordPublicationFailure: OutboxPersistenceService["recordPublicationFailure"] = Effect.fn(
    "PostgresOutboxPersistence.recordPublicationFailure",
  )(function* (input) {
    const operation = Effect.gen(function* () {
      const updatedRows = yield* sql<{ readonly outboxMessageId: unknown }>`
          UPDATE outbox_messages
          SET
            status = CASE ${input.disposition}
              WHEN 'terminal' THEN 'failed'
              ELSE 'pending'
            END,
            failed_at = CASE ${input.disposition}
              WHEN 'terminal' THEN CURRENT_TIMESTAMP
              ELSE NULL
            END,
            publish_claim_id = NULL,
            publish_claimed_until = NULL,
            next_publish_attempt_at = CASE
              WHEN ${input.disposition} = 'terminal' THEN CURRENT_TIMESTAMP
              ELSE CURRENT_TIMESTAMP + (${input.retryDelaySeconds} * INTERVAL '1 second')
            END,
            last_publish_error_code = ${input.errorCode}
          WHERE id = ${input.outboxMessageId}
            AND status = 'pending'
            AND publish_claim_id = ${input.claimId}
          RETURNING id AS "outboxMessageId"
        `;

      yield* resolveClaimTransition({
        operation: "recordOutboxPublicationFailure",
        outboxMessageId: input.outboxMessageId,
        updatedRows,
      });
    });

    return yield* operation.pipe(
      Effect.tapError((cause) =>
        cause instanceof OutboxPublicationStateConflict
          ? Effect.void
          : observePersistenceFailure("recordOutboxPublicationFailure", cause),
      ),
      Effect.mapError((cause) =>
        cause instanceof OutboxPublicationStateConflict
          ? cause
          : persistenceUnavailable("recordOutboxPublicationFailure"),
      ),
    );
  });

  const recordConsumption: OutboxPersistenceService["recordConsumption"] = Effect.fn(
    "PostgresOutboxPersistence.recordConsumption",
  )(function* (input) {
    const operation = Effect.gen(function* () {
      const rows = yield* sql<{
        readonly outboxExists: unknown;
        readonly receiptInserted: unknown;
      }>`
        WITH source AS (
          SELECT id
          FROM outbox_messages
          WHERE id = ${input.outboxMessageId}
        ),
        inserted AS (
          INSERT INTO outbox_message_receipts (outbox_message_id)
          SELECT id FROM source
          ON CONFLICT (outbox_message_id) DO NOTHING
          RETURNING outbox_message_id
        )
        SELECT
          EXISTS (SELECT 1 FROM source) AS "outboxExists",
          EXISTS (SELECT 1 FROM inserted) AS "receiptInserted"
      `;
      const result = yield* Schema.decodeUnknown(OutboxConsumptionRow)(rows[0]);

      return result.receiptInserted
        ? ({ _tag: "Processed" } as const)
        : result.outboxExists
          ? ({ _tag: "Duplicate" } as const)
          : ({ _tag: "NotFound" } as const);
    });

    return yield* operation.pipe(
      Effect.tapError((cause) => observePersistenceFailure("recordOutboxConsumption", cause)),
      Effect.mapError(() => persistenceUnavailable("recordOutboxConsumption")),
    );
  });

  return OutboxPersistence.of({
    claimPending,
    markPublished,
    recordPublicationFailure,
    recordConsumption,
  });
});

/** Dependency-preserving Layer for compositions that already own a PostgreSQL client. */
export const layerWithoutDependencies = Layer.effect(OutboxPersistence, make);

/** Administrative recovery implementation that requires a separately scoped direct client. */
export const makeRecovery = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;

  const recoverFailedPublication: OutboxRecoveryService["recoverFailedPublication"] = Effect.fn(
    "PostgresOutboxRecovery.recoverFailedPublication",
  )(function* (input) {
    const operation = Effect.gen(function* () {
      const rows = yield* sql<{ readonly outboxMessageId: unknown }>`
        UPDATE outbox_messages AS message
        SET
          status = 'pending',
          published_at = NULL,
          failed_at = NULL,
          publish_attempts = 0,
          publish_claim_id = NULL,
          publish_claimed_until = NULL,
          next_publish_attempt_at = CURRENT_TIMESTAMP,
          last_publish_error_code = NULL
        WHERE message.id = ${input.outboxMessageId}
          AND message.status = 'failed'
          AND NOT EXISTS (
            SELECT 1
            FROM outbox_message_receipts AS receipt
            WHERE receipt.outbox_message_id = message.id
          )
        RETURNING message.id AS "outboxMessageId"
      `;

      if (rows.length === 0) {
        return false;
      }

      yield* Schema.decodeUnknown(UpdatedOutboxMessageRow)(rows[0]);
      return true;
    });

    return yield* operation.pipe(
      Effect.tapError((cause) =>
        observePersistenceFailure("recoverFailedOutboxPublication", cause),
      ),
      Effect.mapError(() => persistenceUnavailable("recoverFailedOutboxPublication")),
    );
  });

  return OutboxRecovery.of({ recoverFailedPublication });
});

/** Dependency-preserving administrative Layer for an already secured direct client. */
export const recoveryLayerWithoutDependencies = Layer.effect(OutboxRecovery, makeRecovery);

/**
 * Construct invocation-scoped PostgreSQL outbox persistence.
 *
 * @param databaseUrl - Redacted runtime-role PostgreSQL connection URL.
 * @returns A scoped Layer that owns and releases its PostgreSQL pool.
 */
export function makePostgresOutboxPersistenceLayer(databaseUrl: Redacted.Redacted<string>) {
  const clientLayer = PgClient.layer({
    url: databaseUrl,
    applicationName: "xpensego-outbox-persistence",
    connectTimeout: "5 seconds",
    idleTimeout: "1 second",
    maxConnections: 4,
  }).pipe(
    Layer.tapError((cause) => observePersistenceFailure("connectOutboxPersistence", cause)),
    Layer.mapError(() => persistenceUnavailable("connectOutboxPersistence")),
  );

  return layerWithoutDependencies.pipe(Layer.provide(clientLayer));
}

/** Construct the higher-privilege direct-connection Layer used only by operator tooling. */
export function makePostgresOutboxRecoveryLayer(databaseUrl: Redacted.Redacted<string>) {
  const clientLayer = PgClient.layer({
    url: databaseUrl,
    applicationName: "xpensego-outbox-recovery",
    connectTimeout: "5 seconds",
    idleTimeout: "1 second",
    maxConnections: 1,
  }).pipe(
    Layer.tapError((cause) => observePersistenceFailure("connectOutboxRecovery", cause)),
    Layer.mapError(() => persistenceUnavailable("connectOutboxRecovery")),
  );

  return recoveryLayerWithoutDependencies.pipe(Layer.provide(clientLayer));
}
