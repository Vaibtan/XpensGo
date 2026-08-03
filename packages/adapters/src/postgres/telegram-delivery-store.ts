import { PgClient } from "@effect/sql-pg";
import {
  TelegramDeliveryPersistenceUnavailable,
  TelegramDeliveryStore,
  type TelegramDeliveryStoreService,
} from "@xpensego/domain/channel/deliver-telegram-reply";
import {
  ChannelDeliveryAttemptId,
  OutboundChannelMessageId,
  TelegramReplyIntentV1,
} from "@xpensego/domain/channel/outbound-channel-intent";
import { TelegramConversationId } from "@xpensego/domain/channel/telegram-event";
import { Clock, Effect, Layer, Schema, type Redacted } from "effect";

const DeliveryClaimRow = Schema.Struct({
  outboundMessageId: OutboundChannelMessageId,
  externalConversationId: TelegramConversationId,
  intent: TelegramReplyIntentV1,
  status: Schema.String,
  deliveryAttempts: Schema.Int.pipe(Schema.nonNegative()),
  deliveryClaimId: Schema.NullOr(ChannelDeliveryAttemptId),
  deliveryClaimedUntil: Schema.NullOr(Schema.DateFromSelf),
});
const GeneratedAttemptRow = Schema.Struct({ attemptId: ChannelDeliveryAttemptId });

function persistenceUnavailable(
  operation: TelegramDeliveryPersistenceUnavailable["operation"],
): TelegramDeliveryPersistenceUnavailable {
  return new TelegramDeliveryPersistenceUnavailable({
    operation,
    reason: "database_unavailable",
  });
}

function observePersistenceFailure(
  operation: TelegramDeliveryPersistenceUnavailable["operation"],
  cause: unknown,
) {
  return Effect.logWarning("PostgreSQL Telegram delivery operation failed", {
    operation,
    causeTag: cause instanceof Error ? cause.name : "UnknownFailure",
  });
}

/** PostgreSQL Telegram delivery implementation that requires an already-scoped client. */
export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;

  const claim: TelegramDeliveryStoreService["claim"] = Effect.fn("PostgresTelegramDelivery.claim")(
    function* (input) {
      const operation = Effect.gen(function* () {
        const nowMillis = yield* Clock.currentTimeMillis;
        const rows = yield* sql<{
          readonly deliveryAttempts: unknown;
          readonly deliveryClaimedUntil: unknown;
          readonly deliveryClaimId: unknown;
          readonly externalConversationId: unknown;
          readonly intent: unknown;
          readonly outboundMessageId: unknown;
          readonly status: unknown;
        }>`
        SELECT
          message.id AS "outboundMessageId",
          message.external_conversation_id AS "externalConversationId",
          message.intent,
          message.status,
          message.delivery_attempts AS "deliveryAttempts",
          message.delivery_claim_id AS "deliveryClaimId",
          message.delivery_claimed_until AS "deliveryClaimedUntil"
        FROM outbox_messages AS outbox
        INNER JOIN outbound_channel_messages AS message
          ON message.id = outbox.outbound_message_id
        WHERE outbox.id = ${input.outboxMessageId}
          AND outbox.kind = 'channel.reply.requested.v1'
          AND message.channel = 'telegram'
        FOR UPDATE OF message
      `;
        if (rows.length === 0) {
          return { _tag: "NotFound" } as const;
        }
        const row = yield* Schema.decodeUnknown(DeliveryClaimRow)(rows[0]);
        if (["provider_accepted", "terminal_failure", "outcome_unknown"].includes(row.status)) {
          return { _tag: "Terminal" } as const;
        }
        if (row.status === "delivering") {
          if (row.deliveryClaimedUntil !== null && row.deliveryClaimedUntil.getTime() > nowMillis) {
            return {
              _tag: "Deferred",
              retryAfterSeconds: Math.max(
                1,
                Math.ceil((row.deliveryClaimedUntil.getTime() - nowMillis) / 1_000),
              ),
            } as const;
          }
          if (row.deliveryClaimId !== null) {
            yield* sql`
            UPDATE channel_delivery_attempts
            SET
              status = 'outcome_unknown',
              error_code = 'attempt_lease_expired',
              completed_at = CURRENT_TIMESTAMP
            WHERE id = ${row.deliveryClaimId}
              AND status = 'attempting'
          `;
          }
          yield* sql`
          UPDATE outbound_channel_messages
          SET
            status = 'outcome_unknown',
            delivery_claim_id = NULL,
            delivery_claimed_until = NULL,
            last_error_code = 'attempt_lease_expired',
            terminal_at = CURRENT_TIMESTAMP
          WHERE id = ${row.outboundMessageId}
        `;
          return { _tag: "Terminal" } as const;
        }
        if (row.deliveryAttempts >= input.policy.maximumAttempts) {
          yield* sql`
          UPDATE outbound_channel_messages
          SET
            status = 'terminal_failure',
            last_error_code = 'attempts_exhausted',
            terminal_at = CURRENT_TIMESTAMP
          WHERE id = ${row.outboundMessageId}
        `;
          return { _tag: "Terminal" } as const;
        }

        const [generated] = yield* sql<{ readonly attemptId: unknown }>`
        SELECT gen_random_uuid() AS "attemptId"
      `;
        const { attemptId } = yield* Schema.decodeUnknown(GeneratedAttemptRow)(generated);
        yield* sql`
        UPDATE outbound_channel_messages
        SET
          status = 'delivering',
          delivery_attempts = delivery_attempts + 1,
          delivery_claim_id = ${attemptId},
          delivery_claimed_until = CURRENT_TIMESTAMP
            + (${input.policy.leaseSeconds} * INTERVAL '1 second'),
          last_error_code = NULL
        WHERE id = ${row.outboundMessageId}
      `;
        yield* sql`
        INSERT INTO channel_delivery_attempts (
          id,
          outbound_message_id,
          attempt_number,
          status
        )
        VALUES (
          ${attemptId},
          ${row.outboundMessageId},
          ${row.deliveryAttempts + 1},
          'attempting'
        )
      `;
        return {
          _tag: "Claimed",
          attemptId,
          outboundMessageId: row.outboundMessageId,
          externalConversationId: row.externalConversationId,
          intent: row.intent,
        } as const;
      });

      return yield* sql.withTransaction(operation).pipe(
        Effect.tapError((cause) => observePersistenceFailure("claimTelegramReply", cause)),
        Effect.mapError(() => persistenceUnavailable("claimTelegramReply")),
      );
    },
  );

  const completeAttempt: TelegramDeliveryStoreService["completeAttempt"] = Effect.fn(
    "PostgresTelegramDelivery.completeAttempt",
  )(function* (input) {
    const operation = Effect.gen(function* () {
      const rows = yield* sql`
        SELECT id
        FROM outbound_channel_messages
        WHERE id = ${input.outboundMessageId}
          AND status = 'delivering'
          AND delivery_claim_id = ${input.attemptId}
        FOR UPDATE
      `;
      if (rows.length !== 1) {
        return yield* Effect.fail(persistenceUnavailable("completeTelegramReplyAttempt"));
      }

      const attemptStatus =
        input.outcome._tag === "ProviderAccepted"
          ? "provider_accepted"
          : input.outcome._tag === "TransientFailure"
            ? "transient_failure"
            : input.outcome._tag === "TerminalFailure"
              ? "terminal_failure"
              : "outcome_unknown";
      const providerMessageId =
        input.outcome._tag === "ProviderAccepted" ? input.outcome.providerMessageId : null;
      const errorCode = input.outcome._tag === "ProviderAccepted" ? null : input.outcome.errorCode;
      yield* sql`
        UPDATE channel_delivery_attempts
        SET
          status = ${attemptStatus},
          provider_message_id = ${providerMessageId},
          error_code = ${errorCode},
          completed_at = CURRENT_TIMESTAMP
        WHERE id = ${input.attemptId}
          AND outbound_message_id = ${input.outboundMessageId}
          AND status = 'attempting'
      `;

      if (input.outcome._tag === "TransientFailure") {
        yield* sql`
          UPDATE outbound_channel_messages
          SET
            status = 'pending',
            delivery_claim_id = NULL,
            delivery_claimed_until = NULL,
            last_error_code = ${input.outcome.errorCode}
          WHERE id = ${input.outboundMessageId}
        `;
        return;
      }

      const messageStatus =
        input.outcome._tag === "ProviderAccepted"
          ? "provider_accepted"
          : input.outcome._tag === "TerminalFailure"
            ? "terminal_failure"
            : "outcome_unknown";
      yield* sql`
        UPDATE outbound_channel_messages
        SET
          status = ${messageStatus},
          delivery_claim_id = NULL,
          delivery_claimed_until = NULL,
          provider_message_id = ${providerMessageId},
          last_error_code = ${errorCode},
          provider_accepted_at = CASE
            WHEN ${messageStatus} = 'provider_accepted' THEN CURRENT_TIMESTAMP
            ELSE NULL
          END,
          terminal_at = CASE
            WHEN ${messageStatus} IN ('terminal_failure', 'outcome_unknown')
              THEN CURRENT_TIMESTAMP
            ELSE NULL
          END
        WHERE id = ${input.outboundMessageId}
      `;
    });

    return yield* sql.withTransaction(operation).pipe(
      Effect.tapError((cause) => observePersistenceFailure("completeTelegramReplyAttempt", cause)),
      Effect.mapError(() => persistenceUnavailable("completeTelegramReplyAttempt")),
    );
  });

  return TelegramDeliveryStore.of({ claim, completeAttempt });
});

/** Dependency-preserving Telegram delivery Layer for an existing PostgreSQL client. */
export const layerWithoutDependencies = Layer.effect(TelegramDeliveryStore, make);

/** Construct invocation-scoped PostgreSQL Telegram delivery persistence. */
export function makePostgresTelegramDeliveryStoreLayer(databaseUrl: Redacted.Redacted<string>) {
  const clientLayer = PgClient.layer({
    url: databaseUrl,
    applicationName: "xpensego-telegram-delivery",
    connectTimeout: "5 seconds",
    idleTimeout: "1 second",
    maxConnections: 4,
  }).pipe(
    Layer.tapError((cause) => observePersistenceFailure("connectTelegramDelivery", cause)),
    Layer.mapError(() => persistenceUnavailable("connectTelegramDelivery")),
  );

  return layerWithoutDependencies.pipe(Layer.provide(clientLayer));
}
