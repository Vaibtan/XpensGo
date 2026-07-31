import { SqlError } from "@effect/sql/SqlError";
import { PgClient } from "@effect/sql-pg";
import {
  InboundEventOwnershipMismatch,
  InboundEventPersistenceUnavailable,
  InboundEventStore,
  type PersistInboundEventInput,
} from "@xpensego/domain/channel/accept-inbound-event";
import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import { InboundEventId } from "@xpensego/domain/channel/inbound-event";
import { UserId } from "@xpensego/domain/identity/user-id";
import { LedgerId } from "@xpensego/domain/ledger/ledger-id";
import { Effect, Layer, Schema, type Redacted } from "effect";

const InsertedInboundEvent = Schema.Struct({
  inboundEventId: InboundEventId,
});

const InsertedOutboxMessage = Schema.Struct({
  outboxMessageId: OutboxMessageId,
});

const ExistingInboundEvent = Schema.Struct({
  ownerUserId: UserId,
  ledgerId: LedgerId,
});

const OwnershipConstraintViolation = Schema.Struct({
  code: Schema.Literal("23503"),
  constraint: Schema.Literal("inbound_channel_events_ledger_owner_fk"),
});

function isOwnershipConstraintViolation(error: unknown): boolean {
  return error instanceof SqlError && Schema.is(OwnershipConstraintViolation)(error.cause);
}

/** PostgreSQL-backed inbound-event store that requires an already-scoped client. */
export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;

  const persist = Effect.fn("PostgresInboundEventStore.persist")(function* (
    input: PersistInboundEventInput,
  ) {
    const transaction = Effect.gen(function* () {
      const inboundRows = yield* sql<{ readonly inboundEventId: unknown }>`
        INSERT INTO inbound_channel_events (
          owner_user_id,
          ledger_id,
          channel,
          external_event_id,
          idempotency_key,
          correlation_id
        )
        VALUES (
          ${input.ownerUserId},
          ${input.ledgerId},
          ${input.channel},
          ${input.externalEventId},
          ${input.idempotencyKey},
          ${input.correlationId}
        )
        ON CONFLICT (channel, external_event_id) DO NOTHING
        RETURNING id AS "inboundEventId"
      `;

      if (inboundRows.length === 0) {
        const existingRows = yield* sql<{
          readonly ownerUserId: unknown;
          readonly ledgerId: unknown;
        }>`
          SELECT
            owner_user_id AS "ownerUserId",
            ledger_id AS "ledgerId"
          FROM inbound_channel_events
          WHERE channel = ${input.channel}
            AND external_event_id = ${input.externalEventId}
        `;
        const existing = yield* Schema.decodeUnknown(ExistingInboundEvent)(existingRows[0]);

        if (existing.ownerUserId !== input.ownerUserId || existing.ledgerId !== input.ledgerId) {
          return yield* new InboundEventOwnershipMismatch({
            operation: "persistInboundEvent",
            ownerUserId: input.ownerUserId,
            ledgerId: input.ledgerId,
          });
        }

        return { _tag: "Duplicate" } as const;
      }

      const { inboundEventId } = yield* Schema.decodeUnknown(InsertedInboundEvent)(inboundRows[0]);
      const outboxPayload = {
        version: 1,
        kind: input.outboxKind,
        inboundEventId,
        ownerUserId: input.ownerUserId,
        ledgerId: input.ledgerId,
        correlationId: input.correlationId,
      } as const;

      const outboxRows = yield* sql<{ readonly outboxMessageId: unknown }>`
        INSERT INTO outbox_messages (
          inbound_event_id,
          owner_user_id,
          ledger_id,
          kind,
          payload
        )
        VALUES (
          ${inboundEventId},
          ${input.ownerUserId},
          ${input.ledgerId},
          ${input.outboxKind},
          ${sql.json(outboxPayload)}
        )
        RETURNING id AS "outboxMessageId"
      `;
      const { outboxMessageId } = yield* Schema.decodeUnknown(InsertedOutboxMessage)(outboxRows[0]);

      return {
        _tag: "Accepted",
        inboundEventId,
        outboxMessageId,
      } as const;
    });

    return yield* sql.withTransaction(transaction).pipe(
      Effect.mapError((cause) =>
        cause instanceof InboundEventOwnershipMismatch
          ? cause
          : isOwnershipConstraintViolation(cause)
            ? new InboundEventOwnershipMismatch({
                operation: "persistInboundEvent",
                ownerUserId: input.ownerUserId,
                ledgerId: input.ledgerId,
              })
            : new InboundEventPersistenceUnavailable({
                operation: "persistInboundEvent",
                cause,
              }),
      ),
    );
  });

  return InboundEventStore.of({ persist });
});

/** Dependency-preserving Layer for compositions that already own a PostgreSQL client. */
export const layerWithoutDependencies = Layer.effect(InboundEventStore, make);

/**
 * Construct the complete PostgreSQL inbound-event adapter for one runtime database URL.
 *
 * @param databaseUrl - Redacted runtime-role PostgreSQL connection URL.
 * @returns A scoped Layer that owns and releases its PostgreSQL pool.
 */
export function makePostgresInboundEventStoreLayer(databaseUrl: Redacted.Redacted<string>) {
  const clientLayer = PgClient.layer({
    url: databaseUrl,
    applicationName: "xpensego-inbound-event-store",
    connectTimeout: "5 seconds",
    idleTimeout: "1 second",
    maxConnections: 4,
  }).pipe(
    Layer.mapError(
      (cause) =>
        new InboundEventPersistenceUnavailable({
          operation: "connectInboundEventStore",
          cause,
        }),
    ),
  );

  return layerWithoutDependencies.pipe(Layer.provide(clientLayer));
}
