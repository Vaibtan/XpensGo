import { PgClient } from "@effect/sql-pg";
import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import {
  OutboxBatchLimit,
  OutboxLeaseDurationSeconds,
  OutboxPersistence,
  OutboxPublicationMaximumAttempts,
  OutboxReceiptTimeoutSeconds,
  OutboxRecovery,
  OutboxRetryDelaySeconds,
} from "@xpensego/domain/outbox/outbox-delivery";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { makeIsolatedTestDatabase } from "./isolated-test-database.js";
import { runMigrations } from "./migrations.js";
import {
  makePostgresOutboxPersistenceLayer,
  makePostgresOutboxRecoveryLayer,
} from "./outbox-store.js";

const testDatabase = makeIsolatedTestDatabase("xpensego_outbox_store_integration");
const migrationClientLayer = PgClient.layer({
  url: testDatabase.migrationUrl,
  applicationName: "xpensego-outbox-fixtures",
  maxConnections: 1,
});
const outboxPersistenceLayer = makePostgresOutboxPersistenceLayer(testDatabase.runtimeUrl);
const outboxRecoveryLayer = makePostgresOutboxRecoveryLayer(testDatabase.migrationUrl);
const claimPolicy = {
  limit: Schema.decodeUnknownSync(OutboxBatchLimit)(2),
  leaseDurationSeconds: Schema.decodeUnknownSync(OutboxLeaseDurationSeconds)(60),
  maximumAttempts: Schema.decodeUnknownSync(OutboxPublicationMaximumAttempts)(5),
  receiptTimeoutSeconds: Schema.decodeUnknownSync(OutboxReceiptTimeoutSeconds)(600),
} as const;
const immediateRetry = Schema.decodeUnknownSync(OutboxRetryDelaySeconds)(0);

const fixtureIds = {
  ownerUserId: "0a37f42e-a007-4d0d-adc2-98098f486ecc",
  ledgerId: "34502fb7-d5c9-4a30-a480-54c66583240a",
  firstInboundEventId: "6471b53a-1525-4535-9202-a13e27f4d84c",
  firstOutboxMessageId: Schema.decodeUnknownSync(OutboxMessageId)(
    "98b2ea19-c24e-49a3-a808-f39667b3c32e",
  ),
  secondInboundEventId: "44308dbf-f118-4683-855f-218a41d865ea",
  secondOutboxMessageId: Schema.decodeUnknownSync(OutboxMessageId)(
    "9f7f01f4-74d4-4a87-86b4-6880114d22b1",
  ),
} as const;

const seedOutbox = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;

  yield* sql`
    INSERT INTO users (id) VALUES (${fixtureIds.ownerUserId})
  `;
  yield* sql`
    INSERT INTO ledgers (id, owner_user_id)
    VALUES (${fixtureIds.ledgerId}, ${fixtureIds.ownerUserId})
  `;
  yield* sql`
    INSERT INTO inbound_channel_events (
      id,
      owner_user_id,
      ledger_id,
      channel,
      external_event_id,
      idempotency_key,
      correlation_id
    )
    VALUES
      (
        ${fixtureIds.firstInboundEventId},
        ${fixtureIds.ownerUserId},
        ${fixtureIds.ledgerId},
        'telegram',
        'update-1',
        'telegram:update-1',
        '0a07b859-8572-4f11-bc54-36ee65c96ac5'
      ),
      (
        ${fixtureIds.secondInboundEventId},
        ${fixtureIds.ownerUserId},
        ${fixtureIds.ledgerId},
        'telegram',
        'update-2',
        'telegram:update-2',
        '153aa2c8-072c-4ce9-a7d4-b1c0ac4ad2a2'
      )
  `;
  yield* sql`
    INSERT INTO outbox_messages (
      id,
      inbound_event_id,
      owner_user_id,
      ledger_id,
      kind,
      payload
    )
    VALUES
      (
        ${fixtureIds.firstOutboxMessageId},
        ${fixtureIds.firstInboundEventId},
        ${fixtureIds.ownerUserId},
        ${fixtureIds.ledgerId},
        'channel.event.received.v1',
        ${sql.json({
          version: 1,
          kind: "channel.event.received.v1",
          inboundEventId: fixtureIds.firstInboundEventId,
          ownerUserId: fixtureIds.ownerUserId,
          ledgerId: fixtureIds.ledgerId,
          correlationId: "0a07b859-8572-4f11-bc54-36ee65c96ac5",
        })}
      ),
      (
        ${fixtureIds.secondOutboxMessageId},
        ${fixtureIds.secondInboundEventId},
        ${fixtureIds.ownerUserId},
        ${fixtureIds.ledgerId},
        'channel.event.received.v1',
        ${sql.json({
          version: 1,
          kind: "channel.event.received.v1",
          inboundEventId: fixtureIds.secondInboundEventId,
          ownerUserId: fixtureIds.ownerUserId,
          ledgerId: fixtureIds.ledgerId,
          correlationId: "153aa2c8-072c-4ce9-a7d4-b1c0ac4ad2a2",
        })}
      )
  `;
}).pipe(Effect.provide(migrationClientLayer), Effect.scoped);

async function withFreshOutboxDatabase<A>(run: () => Promise<A>): Promise<A> {
  await Effect.runPromise(testDatabase.recreate);

  try {
    await Effect.runPromise(runMigrations(testDatabase.migrationUrl));
    await Effect.runPromise(seedOutbox);
    return await run();
  } finally {
    await Effect.runPromise(testDatabase.drop);
  }
}

describe("PostgreSQL outbox persistence", () => {
  it("claims distinct messages across concurrent dispatchers", async () => {
    await withFreshOutboxDatabase(async () => {
      const claimed = await Effect.runPromise(
        Effect.gen(function* () {
          const persistence = yield* OutboxPersistence;
          return yield* Effect.all(
            [
              persistence.claimPending({
                ...claimPolicy,
                limit: Schema.decodeUnknownSync(OutboxBatchLimit)(1),
              }),
              persistence.claimPending({
                ...claimPolicy,
                limit: Schema.decodeUnknownSync(OutboxBatchLimit)(1),
              }),
            ],
            { concurrency: 2 },
          );
        }).pipe(Effect.provide(outboxPersistenceLayer), Effect.scoped),
      );

      expect(claimed[0]).toHaveLength(1);
      expect(claimed[1]).toHaveLength(1);
      expect(claimed[0][0]?.outboxMessageId).not.toBe(claimed[1][0]?.outboxMessageId);
    });
  });

  it("reclaims a failed publication after its retry delay", async () => {
    await withFreshOutboxDatabase(async () => {
      const attempts = await Effect.runPromise(
        Effect.gen(function* () {
          const persistence = yield* OutboxPersistence;
          const [first, other] = yield* persistence.claimPending(claimPolicy);
          if (first === undefined || other === undefined) {
            return yield* Effect.die("Expected two claimed outbox messages");
          }
          yield* persistence.markPublished({
            outboxMessageId: other.outboxMessageId,
            claimId: other.claimId,
          });
          yield* persistence.recordPublicationFailure({
            outboxMessageId: first.outboxMessageId,
            claimId: first.claimId,
            errorCode: "queue_unavailable",
            retryDelaySeconds: immediateRetry,
            disposition: "retry",
          });
          const [second] = yield* persistence.claimPending({
            ...claimPolicy,
            limit: Schema.decodeUnknownSync(OutboxBatchLimit)(1),
          });
          if (second === undefined) {
            return yield* Effect.die("Expected the outbox message to be reclaimed");
          }
          return [first.attempt, second.attempt] as const;
        }).pipe(Effect.provide(outboxPersistenceLayer), Effect.scoped),
      );

      expect(attempts).toEqual([1, 2]);
    });
  });

  it("uses a consumer receipt to suppress ambiguous republishing and duplicate processing", async () => {
    await withFreshOutboxDatabase(async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const persistence = yield* OutboxPersistence;
          const [claimed] = yield* persistence.claimPending({
            ...claimPolicy,
            limit: Schema.decodeUnknownSync(OutboxBatchLimit)(1),
          });
          if (claimed === undefined) {
            return yield* Effect.die("Expected one claimed outbox message");
          }
          const firstConsumption = yield* persistence.recordConsumption({
            outboxMessageId: claimed.outboxMessageId,
          });
          const afterReceipt = yield* persistence.claimPending(claimPolicy);
          const secondConsumption = yield* persistence.recordConsumption({
            outboxMessageId: claimed.outboxMessageId,
          });
          const missingConsumption = yield* persistence.recordConsumption({
            outboxMessageId: Schema.decodeUnknownSync(OutboxMessageId)(
              "ec1c9cd9-cc6b-48a2-90ab-8d298281736c",
            ),
          });
          return {
            claimed,
            firstConsumption,
            afterReceipt,
            secondConsumption,
            missingConsumption,
          };
        }).pipe(Effect.provide(outboxPersistenceLayer), Effect.scoped),
      );

      expect(result.firstConsumption).toEqual({ _tag: "Processed" });
      expect(result.secondConsumption).toEqual({ _tag: "Duplicate" });
      expect(result.missingConsumption).toEqual({ _tag: "NotFound" });
      expect(result.afterReceipt.map((message) => message.outboxMessageId)).not.toContain(
        result.claimed.outboxMessageId,
      );
    });
  });

  it("terminalizes exhausted publication and allows explicit operator recovery", async () => {
    await withFreshOutboxDatabase(async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`
            UPDATE outbox_messages
            SET publish_attempts = 4
            WHERE id = ${fixtureIds.firstOutboxMessageId}
          `;
          const persistence = yield* OutboxPersistence;
          const [claimed] = yield* persistence.claimPending({
            ...claimPolicy,
            limit: Schema.decodeUnknownSync(OutboxBatchLimit)(1),
          });
          if (claimed === undefined) {
            return yield* Effect.die("Expected the final publication claim");
          }
          yield* persistence.recordPublicationFailure({
            outboxMessageId: claimed.outboxMessageId,
            claimId: claimed.claimId,
            errorCode: "queue_unavailable",
            retryDelaySeconds: immediateRetry,
            disposition: "terminal",
          });
          const afterFailure = yield* persistence.claimPending(claimPolicy);
          const recovery = yield* OutboxRecovery;
          const recovered = yield* recovery.recoverFailedPublication({
            outboxMessageId: claimed.outboxMessageId,
          });
          const afterRecovery = yield* persistence.claimPending(claimPolicy);
          return { claimed, afterFailure, recovered, afterRecovery };
        }).pipe(
          Effect.provide(
            Layer.mergeAll(outboxPersistenceLayer, outboxRecoveryLayer, migrationClientLayer),
          ),
          Effect.scoped,
        ),
      );

      expect(result.claimed.attempt).toBe(5);
      expect(result.afterFailure.map((message) => message.outboxMessageId)).not.toContain(
        result.claimed.outboxMessageId,
      );
      expect(result.recovered).toBe(true);
      expect(result.afterRecovery).toContainEqual(
        expect.objectContaining({
          outboxMessageId: result.claimed.outboxMessageId,
          attempt: 1,
        }),
      );
    });
  });

  it("re-enqueues a published message whose consumer receipt is stalled", async () => {
    await withFreshOutboxDatabase(async () => {
      const reclaimed = await Effect.runPromise(
        Effect.gen(function* () {
          const persistence = yield* OutboxPersistence;
          const [claimed] = yield* persistence.claimPending({
            ...claimPolicy,
            limit: Schema.decodeUnknownSync(OutboxBatchLimit)(1),
          });
          if (claimed === undefined) {
            return yield* Effect.die("Expected one claimed outbox message");
          }
          yield* persistence.markPublished({
            outboxMessageId: claimed.outboxMessageId,
            claimId: claimed.claimId,
          });
          const sql = yield* PgClient.PgClient;
          yield* sql`
            UPDATE outbox_messages
            SET published_at = CURRENT_TIMESTAMP - INTERVAL '11 minutes'
            WHERE id = ${claimed.outboxMessageId}
          `;
          const afterReconciliation = yield* persistence.claimPending(claimPolicy);
          return afterReconciliation.find(
            (message) => message.outboxMessageId === claimed.outboxMessageId,
          );
        }).pipe(
          Effect.provide(Layer.merge(outboxPersistenceLayer, migrationClientLayer)),
          Effect.scoped,
        ),
      );

      expect(reclaimed).toEqual(
        expect.objectContaining({
          outboxMessageId: fixtureIds.firstOutboxMessageId,
          attempt: 2,
        }),
      );
    });
  });
});
