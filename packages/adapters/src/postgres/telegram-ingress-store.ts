import { PgClient } from "@effect/sql-pg";
import {
  TelegramIngressPersistenceUnavailable,
  TelegramIngressStore,
  type PersistTelegramEventInput,
} from "@xpensego/domain/channel/accept-telegram-event";
import { InboundEventId } from "@xpensego/domain/channel/inbound-event";
import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import { Effect, Layer, Schema, type Redacted } from "effect";

const InsertedTelegramEvent = Schema.Struct({ inboundEventId: InboundEventId });
const InsertedTelegramOutbox = Schema.Struct({ outboxMessageId: OutboxMessageId });

function persistenceUnavailable(
  operation: TelegramIngressPersistenceUnavailable["operation"],
): TelegramIngressPersistenceUnavailable {
  return new TelegramIngressPersistenceUnavailable({ operation, reason: "database_unavailable" });
}

function observePersistenceFailure(
  operation: TelegramIngressPersistenceUnavailable["operation"],
  cause: unknown,
) {
  return Effect.logWarning("PostgreSQL Telegram ingress operation failed", {
    operation,
    causeTag: cause instanceof Error ? cause.name : "UnknownFailure",
  });
}

/** PostgreSQL Telegram ingress implementation that requires an already-scoped client. */
export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;

  const persist = Effect.fn("PostgresTelegramIngress.persist")(function* (
    input: PersistTelegramEventInput,
  ) {
    const transaction = Effect.gen(function* () {
      const inboundRows = yield* sql<{ readonly inboundEventId: unknown }>`
        INSERT INTO inbound_channel_events (
          channel,
          external_event_id,
          idempotency_key,
          correlation_id,
          normalized_payload,
          processing_status
        )
        VALUES (
          'telegram',
          ${input.event.updateId},
          ${input.idempotencyKey},
          ${input.correlationId},
          ${sql.json(input.event)},
          'pending'
        )
        ON CONFLICT (channel, external_event_id) DO NOTHING
        RETURNING id AS "inboundEventId"
      `;

      if (inboundRows.length === 0) {
        return { _tag: "Duplicate" } as const;
      }

      const { inboundEventId } = yield* Schema.decodeUnknown(InsertedTelegramEvent)(inboundRows[0]);
      const payload = {
        version: 1,
        kind: input.outboxKind,
        inboundEventId,
        correlationId: input.correlationId,
      } as const;
      const outboxRows = yield* sql<{ readonly outboxMessageId: unknown }>`
        INSERT INTO outbox_messages (
          inbound_event_id,
          kind,
          payload
        )
        VALUES (
          ${inboundEventId},
          ${input.outboxKind},
          ${sql.json(payload)}
        )
        RETURNING id AS "outboxMessageId"
      `;
      const { outboxMessageId } = yield* Schema.decodeUnknown(InsertedTelegramOutbox)(
        outboxRows[0],
      );

      return { _tag: "Accepted", inboundEventId, outboxMessageId } as const;
    });

    return yield* sql.withTransaction(transaction).pipe(
      Effect.tapError((cause) => observePersistenceFailure("persistTelegramEvent", cause)),
      Effect.mapError(() => persistenceUnavailable("persistTelegramEvent")),
    );
  });

  return TelegramIngressStore.of({ persist });
});

/** Dependency-preserving Telegram ingress Layer for an existing PostgreSQL client. */
export const layerWithoutDependencies = Layer.effect(TelegramIngressStore, make);

/** Construct invocation-scoped PostgreSQL Telegram ingress persistence. */
export function makePostgresTelegramIngressStoreLayer(databaseUrl: Redacted.Redacted<string>) {
  const clientLayer = PgClient.layer({
    url: databaseUrl,
    applicationName: "xpensego-telegram-ingress",
    connectTimeout: "5 seconds",
    idleTimeout: "1 second",
    maxConnections: 4,
  }).pipe(
    Layer.tapError((cause) => observePersistenceFailure("connectTelegramIngress", cause)),
    Layer.mapError(() => persistenceUnavailable("connectTelegramIngress")),
  );

  return layerWithoutDependencies.pipe(Layer.provide(clientLayer));
}
