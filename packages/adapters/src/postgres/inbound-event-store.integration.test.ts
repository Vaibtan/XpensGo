import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import {
  InboundEventOwnershipMismatch,
  InboundEventPersistenceUnavailable,
  acceptInboundEvent,
} from "@xpensego/domain/channel/accept-inbound-event";
import { ExternalChannelEventId, InboundEventId } from "@xpensego/domain/channel/inbound-event";
import { UserId } from "@xpensego/domain/identity/user-id";
import { LedgerId } from "@xpensego/domain/ledger/ledger-id";
import { OutboxMessageId } from "@xpensego/domain/outbox/outbox-message-id";
import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { Effect, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makePostgresInboundEventStoreLayer } from "./inbound-event-store.js";
import { makeIsolatedTestDatabase } from "./isolated-test-database.js";
import { runMigrations } from "./migrations.js";

const testDatabase = makeIsolatedTestDatabase("xpensego_inbound_store_integration");

const ownerUserId = Schema.decodeUnknownSync(UserId)("11111111-1111-4111-8111-111111111111");
const otherUserId = Schema.decodeUnknownSync(UserId)("22222222-2222-4222-8222-222222222222");
const ledgerId = Schema.decodeUnknownSync(LedgerId)("33333333-3333-4333-8333-333333333333");
const correlationId = Schema.decodeUnknownSync(CorrelationId)(
  "f3124c5a-82d1-45cf-924c-242e284afc6a",
);
const externalEventId = Schema.decodeUnknownSync(ExternalChannelEventId)("telegram-update-1001");

const migrationClientLayer = PgClient.layer({
  url: testDatabase.migrationUrl,
  applicationName: "xpensego-integration-setup",
  maxConnections: 1,
});

const resetDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`GRANT INSERT ON outbox_messages TO xpensego_runtime`;
  yield* sql`DELETE FROM outbox_messages`;
  yield* sql`DELETE FROM inbound_channel_events`;
  yield* sql`DELETE FROM ledgers`;
  yield* sql`DELETE FROM users`;
  yield* sql`INSERT INTO users (id) VALUES (${ownerUserId}), (${otherUserId})`;
  yield* sql`INSERT INTO ledgers (id, owner_user_id) VALUES (${ledgerId}, ${ownerUserId})`;
}).pipe(Effect.provide(migrationClientLayer), Effect.scoped);

const input = {
  ownerUserId,
  ledgerId,
  channel: "telegram",
  externalEventId,
  correlationId,
} as const;

const readPersistedCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [counts] = yield* sql<{
    readonly inboundEventCount: number;
    readonly outboxMessageCount: number;
  }>`
    SELECT
      (SELECT count(*)::integer FROM inbound_channel_events) AS "inboundEventCount",
      (SELECT count(*)::integer FROM outbox_messages) AS "outboxMessageCount"
  `;

  return counts;
}).pipe(Effect.provide(migrationClientLayer), Effect.scoped);

const revokeOutboxInsert = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`REVOKE INSERT ON outbox_messages FROM xpensego_runtime`;
}).pipe(Effect.provide(migrationClientLayer), Effect.scoped);

const restoreOutboxInsert = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`GRANT INSERT ON outbox_messages TO xpensego_runtime`;
}).pipe(Effect.provide(migrationClientLayer), Effect.scoped);

describe("PostgreSQL inbound event store", () => {
  beforeAll(async () => {
    await Effect.runPromise(testDatabase.recreate);
    await Effect.runPromise(runMigrations(testDatabase.migrationUrl));
  });

  afterAll(async () => {
    await Effect.runPromise(testDatabase.drop);
  });

  beforeEach(async () => {
    await Effect.runPromise(resetDatabase);
  });

  it("converges concurrent duplicate deliveries on one event and outbox message", async () => {
    const outcomes = await Effect.runPromise(
      Effect.all([acceptInboundEvent(input), acceptInboundEvent(input)], {
        concurrency: 2,
      }).pipe(Effect.provide(makePostgresInboundEventStoreLayer(testDatabase.runtimeUrl))),
    );

    expect(outcomes.map((outcome) => outcome._tag).sort()).toEqual(["Accepted", "Duplicate"]);

    const accepted = outcomes.find((outcome) => outcome._tag === "Accepted");
    expect(accepted).toBeDefined();
    if (accepted?._tag === "Accepted") {
      expect(Schema.is(InboundEventId)(accepted.inboundEventId)).toBe(true);
      expect(Schema.is(OutboxMessageId)(accepted.outboxMessageId)).toBe(true);
    }

    await expect(Effect.runPromise(readPersistedCounts)).resolves.toEqual({
      inboundEventCount: 1,
      outboxMessageCount: 1,
    });
  });

  it("rejects cross-owner ledger access without consuming the idempotency key", async () => {
    const layer = makePostgresInboundEventStoreLayer(testDatabase.runtimeUrl);
    const error = await Effect.runPromise(
      acceptInboundEvent({ ...input, ownerUserId: otherUserId }).pipe(
        Effect.provide(layer),
        Effect.flip,
      ),
    );

    expect(error).toBeInstanceOf(InboundEventOwnershipMismatch);

    await expect(Effect.runPromise(readPersistedCounts)).resolves.toEqual({
      inboundEventCount: 0,
      outboxMessageCount: 0,
    });

    const accepted = await Effect.runPromise(acceptInboundEvent(input).pipe(Effect.provide(layer)));
    expect(accepted._tag).toBe("Accepted");
  });

  it("rejects a replay when the existing event belongs to another owner", async () => {
    const layer = makePostgresInboundEventStoreLayer(testDatabase.runtimeUrl);
    const accepted = await Effect.runPromise(acceptInboundEvent(input).pipe(Effect.provide(layer)));
    expect(accepted._tag).toBe("Accepted");

    const error = await Effect.runPromise(
      acceptInboundEvent({ ...input, ownerUserId: otherUserId }).pipe(
        Effect.provide(layer),
        Effect.flip,
      ),
    );

    expect(error).toBeInstanceOf(InboundEventOwnershipMismatch);
    await expect(Effect.runPromise(readPersistedCounts)).resolves.toEqual({
      inboundEventCount: 1,
      outboxMessageCount: 1,
    });
  });

  it("rolls back the inbound event when the outbox write fails", async () => {
    await Effect.runPromise(revokeOutboxInsert);

    try {
      const error = await Effect.runPromise(
        acceptInboundEvent(input).pipe(
          Effect.provide(makePostgresInboundEventStoreLayer(testDatabase.runtimeUrl)),
          Effect.flip,
        ),
      );

      expect(error).toBeInstanceOf(InboundEventPersistenceUnavailable);
      await expect(Effect.runPromise(readPersistedCounts)).resolves.toEqual({
        inboundEventCount: 0,
        outboxMessageCount: 0,
      });
    } finally {
      await Effect.runPromise(restoreOutboxInsert);
    }
  });
});
