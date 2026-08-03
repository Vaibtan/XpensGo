import { PgClient } from "@effect/sql-pg";
import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import {
  TelegramDeliveryRecoveryExpectedErrorCode,
  TelegramDeliveryRecoveryId,
  TelegramDeliveryRecoveryPersistenceUnavailable,
  TelegramDeliveryRecoveryReason,
  TelegramDeliveryRecoveryStore,
  type TelegramDeliveryRecoveryStoreService,
} from "@xpensego/domain/channel/recover-telegram-delivery";
import { OutboundChannelMessageId } from "@xpensego/domain/channel/outbound-channel-intent";
import { Effect, Layer, Schema, type Redacted } from "effect";

const ExistingRecoveryRow = Schema.Struct({
  recoveryId: TelegramDeliveryRecoveryId,
  outboundMessageId: OutboundChannelMessageId,
  outboxMessageId: OutboxMessageId,
  correlationId: CorrelationId,
  expectedErrorCode: TelegramDeliveryRecoveryExpectedErrorCode,
  reason: TelegramDeliveryRecoveryReason,
  publicationStatus: Schema.Literal("prepared", "published"),
});

const RecoverableMessageRow = Schema.Struct({
  outboundMessageId: OutboundChannelMessageId,
  outboxMessageId: OutboxMessageId,
  correlationId: CorrelationId,
  status: Schema.Literal(
    "pending",
    "delivering",
    "provider_accepted",
    "terminal_failure",
    "outcome_unknown",
  ),
  deliveryAttempts: Schema.Int.pipe(Schema.nonNegative()),
  lastErrorCode: Schema.NullOr(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64))),
});

function persistenceUnavailable(
  operation: TelegramDeliveryRecoveryPersistenceUnavailable["operation"],
): TelegramDeliveryRecoveryPersistenceUnavailable {
  return new TelegramDeliveryRecoveryPersistenceUnavailable({
    operation,
    reason: "database_unavailable",
  });
}

function observePersistenceFailure(
  operation: TelegramDeliveryRecoveryPersistenceUnavailable["operation"],
  cause: unknown,
) {
  return Effect.logWarning("PostgreSQL Telegram delivery recovery operation failed", {
    operation,
    causeTag: cause instanceof Error ? cause.name : "UnknownFailure",
  });
}

/** PostgreSQL recovery implementation that requires an already scoped administrative client. */
export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;

  const prepare: TelegramDeliveryRecoveryStoreService["prepare"] = Effect.fn(
    "PostgresTelegramDeliveryRecovery.prepare",
  )(function* (input) {
    const operation = Effect.gen(function* () {
      const existingRows = yield* sql<{
        readonly recoveryId: unknown;
        readonly outboundMessageId: unknown;
        readonly outboxMessageId: unknown;
        readonly correlationId: unknown;
        readonly expectedErrorCode: unknown;
        readonly reason: unknown;
        readonly publicationStatus: unknown;
      }>`
        SELECT
          id AS "recoveryId",
          outbound_message_id AS "outboundMessageId",
          outbox_message_id AS "outboxMessageId",
          correlation_id AS "correlationId",
          expected_error_code AS "expectedErrorCode",
          reason,
          publication_status AS "publicationStatus"
        FROM telegram_delivery_recoveries
        WHERE id = ${input.recoveryId}
      `;
      if (existingRows.length > 0) {
        const existing = yield* Schema.decodeUnknown(ExistingRecoveryRow)(existingRows[0]);
        if (
          existing.outboundMessageId !== input.outboundMessageId ||
          existing.expectedErrorCode !== input.expectedErrorCode ||
          existing.reason !== input.reason
        ) {
          return { _tag: "NotRecoverable", reason: "idempotency_conflict" } as const;
        }
        return {
          _tag: "Prepared",
          publicationStatus: existing.publicationStatus,
          outboxMessageId: existing.outboxMessageId,
          correlationId: existing.correlationId,
        } as const;
      }

      const messageRows = yield* sql<{
        readonly outboundMessageId: unknown;
        readonly outboxMessageId: unknown;
        readonly correlationId: unknown;
        readonly status: unknown;
        readonly deliveryAttempts: unknown;
        readonly lastErrorCode: unknown;
      }>`
        SELECT
          message.id AS "outboundMessageId",
          outbox.id AS "outboxMessageId",
          message.correlation_id AS "correlationId",
          message.status,
          message.delivery_attempts AS "deliveryAttempts",
          message.last_error_code AS "lastErrorCode"
        FROM outbound_channel_messages AS message
        INNER JOIN outbox_messages AS outbox
          ON outbox.outbound_message_id = message.id
          AND outbox.kind = 'channel.reply.requested.v1'
        WHERE message.id = ${input.outboundMessageId}
          AND message.channel = 'telegram'
        FOR UPDATE OF message
      `;
      if (messageRows.length === 0) {
        return { _tag: "NotRecoverable", reason: "not_found" } as const;
      }
      const message = yield* Schema.decodeUnknown(RecoverableMessageRow)(messageRows[0]);
      if (message.status === "provider_accepted") {
        return { _tag: "NotRecoverable", reason: "provider_accepted" } as const;
      }
      if (message.status === "outcome_unknown") {
        return { _tag: "NotRecoverable", reason: "outcome_unknown" } as const;
      }
      if (message.status !== "terminal_failure") {
        return { _tag: "NotRecoverable", reason: "not_terminal_failure" } as const;
      }
      if (message.lastErrorCode !== input.expectedErrorCode) {
        return { _tag: "NotRecoverable", reason: "error_code_mismatch" } as const;
      }
      if (message.deliveryAttempts >= input.maximumAttempts) {
        return { _tag: "NotRecoverable", reason: "attempt_limit_reached" } as const;
      }

      yield* sql`
        UPDATE outbound_channel_messages
        SET
          status = 'pending',
          delivery_claim_id = NULL,
          delivery_claimed_until = NULL,
          last_error_code = NULL,
          terminal_at = NULL
        WHERE id = ${message.outboundMessageId}
      `;
      yield* sql`
        INSERT INTO telegram_delivery_recoveries (
          id,
          outbound_message_id,
          outbox_message_id,
          correlation_id,
          expected_error_code,
          reason
        )
        VALUES (
          ${input.recoveryId},
          ${message.outboundMessageId},
          ${message.outboxMessageId},
          ${message.correlationId},
          ${input.expectedErrorCode},
          ${input.reason}
        )
      `;

      return {
        _tag: "Prepared",
        publicationStatus: "prepared",
        outboxMessageId: message.outboxMessageId,
        correlationId: message.correlationId,
      } as const;
    });

    return yield* sql.withTransaction(operation).pipe(
      Effect.tapError((cause) =>
        observePersistenceFailure("prepareTelegramDeliveryRecovery", cause),
      ),
      Effect.mapError(() => persistenceUnavailable("prepareTelegramDeliveryRecovery")),
    );
  });

  const markPublished: TelegramDeliveryRecoveryStoreService["markPublished"] = Effect.fn(
    "PostgresTelegramDeliveryRecovery.markPublished",
  )(function* (input) {
    const operation = Effect.gen(function* () {
      const updated = yield* sql`
        UPDATE telegram_delivery_recoveries
        SET
          publication_status = 'published',
          published_at = CURRENT_TIMESTAMP
        WHERE id = ${input.recoveryId}
          AND publication_status = 'prepared'
        RETURNING id
      `;
      if (updated.length > 0) {
        return { _tag: "Published" } as const;
      }

      const rows = yield* sql<{ readonly publicationStatus: unknown }>`
        SELECT publication_status AS "publicationStatus"
        FROM telegram_delivery_recoveries
        WHERE id = ${input.recoveryId}
      `;
      if (rows.length === 0) {
        return { _tag: "NotFound" } as const;
      }
      const status = yield* Schema.decodeUnknown(
        Schema.Struct({ publicationStatus: Schema.Literal("prepared", "published") }),
      )(rows[0]);
      return status.publicationStatus === "published"
        ? ({ _tag: "AlreadyPublished" } as const)
        : ({ _tag: "Published" } as const);
    });

    return yield* operation.pipe(
      Effect.tapError((cause) =>
        observePersistenceFailure("markTelegramDeliveryRecoveryPublished", cause),
      ),
      Effect.mapError(() => persistenceUnavailable("markTelegramDeliveryRecoveryPublished")),
    );
  });

  return TelegramDeliveryRecoveryStore.of({ prepare, markPublished });
});

/** Dependency-preserving recovery Layer for an existing administrative PostgreSQL client. */
export const layerWithoutDependencies = Layer.effect(TelegramDeliveryRecoveryStore, make);

/** Construct the direct administrative PostgreSQL Layer used only by operator tooling. */
export function makePostgresTelegramDeliveryRecoveryStoreLayer(
  databaseUrl: Redacted.Redacted<string>,
) {
  const clientLayer = PgClient.layer({
    url: databaseUrl,
    applicationName: "xpensego-telegram-delivery-recovery",
    connectTimeout: "5 seconds",
    idleTimeout: "1 second",
    maxConnections: 1,
  }).pipe(
    Layer.tapError((cause) => observePersistenceFailure("connectTelegramDeliveryRecovery", cause)),
    Layer.mapError(() => persistenceUnavailable("connectTelegramDeliveryRecovery")),
  );

  return layerWithoutDependencies.pipe(Layer.provide(clientLayer));
}
