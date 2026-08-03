import { PgClient } from "@effect/sql-pg";
import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import {
  TelegramDeliveryLeaseSeconds,
  TelegramDeliveryStore,
  TelegramMaximumDeliveryAttempts,
} from "@xpensego/domain/channel/deliver-telegram-reply";
import { OutboundChannelMessageId } from "@xpensego/domain/channel/outbound-channel-intent";
import {
  TelegramDeliveryRecoveryExpectedErrorCode,
  TelegramDeliveryRecoveryId,
  TelegramDeliveryRecoveryStore,
} from "@xpensego/domain/channel/recover-telegram-delivery";
import { Effect, Layer, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeIsolatedTestDatabase } from "./isolated-test-database.js";
import { runMigrations } from "./migrations.js";
import { makePostgresTelegramDeliveryStoreLayer } from "./telegram-delivery-store.js";
import { makePostgresTelegramDeliveryRecoveryStoreLayer } from "./telegram-delivery-recovery-store.js";

const testDatabase = makeIsolatedTestDatabase("xpensego_telegram_delivery_integration");
const fixtureClientLayer = PgClient.layer({
  url: testDatabase.migrationUrl,
  applicationName: "xpensego-telegram-delivery-fixtures",
  maxConnections: 1,
});
const deliveryLayer = makePostgresTelegramDeliveryStoreLayer(testDatabase.runtimeUrl);
const recoveryLayer = makePostgresTelegramDeliveryRecoveryStoreLayer(testDatabase.migrationUrl);
const deliveryAndRecoveryLayer = Layer.merge(deliveryLayer, recoveryLayer);
const policy = {
  maximumAttempts: TelegramMaximumDeliveryAttempts.make(3),
  leaseSeconds: TelegramDeliveryLeaseSeconds.make(60),
} as const;
const correlationId = Schema.decodeUnknownSync(CorrelationId)(
  "bfda0c22-5be5-44c0-9c27-85ea19be7121",
);
const intent = {
  version: 1,
  channel: "telegram",
  purpose: "system",
  privacy: "private",
  content: { _tag: "LinkRequired" },
  actions: [{ _tag: "OpenWeb", path: "/workspace" }],
} as const;

async function createReplyFixture(suffix: string) {
  const row = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const [event] = yield* sql<{ readonly inboundEventId: string }>`
        INSERT INTO inbound_channel_events (
          channel,
          external_event_id,
          idempotency_key,
          correlation_id,
          normalized_payload,
          processing_status,
          processing_outcome,
          processed_at,
          abuse_checked_at,
          abuse_allowed
        )
        VALUES (
          'telegram',
          ${`delivery-${suffix}`},
          ${`telegram:update:delivery-${suffix}`},
          ${correlationId},
          ${sql.json({
            version: 1,
            updateId: suffix,
            externalAccountId: "777777",
            externalConversationId: "777777",
            externalMessageId: suffix,
            occurredAtMillis: 1_785_638_402_000,
            content: { _tag: "Text", text: "fixture" },
          })},
          'processed',
          'unscoped_reply_created',
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP,
          TRUE
        )
        RETURNING id AS "inboundEventId"
      `;
      const [outbound] = yield* sql<{ readonly outboundMessageId: string }>`
        INSERT INTO outbound_channel_messages (
          inbound_event_id,
          channel,
          external_conversation_id,
          intent,
          correlation_id
        )
        VALUES (
          ${event?.inboundEventId},
          'telegram',
          '777777',
          ${sql.json(intent)},
          ${correlationId}
        )
        RETURNING id AS "outboundMessageId"
      `;
      const [outbox] = yield* sql<{ readonly outboxMessageId: string }>`
        INSERT INTO outbox_messages (
          inbound_event_id,
          outbound_message_id,
          kind,
          payload
        )
        VALUES (
          ${event?.inboundEventId},
          ${outbound?.outboundMessageId},
          'channel.reply.requested.v1',
          ${sql.json({
            version: 1,
            kind: "channel.reply.requested.v1",
            outboundMessageId: outbound?.outboundMessageId,
            correlationId,
          })}
        )
        RETURNING id AS "outboxMessageId"
      `;
      return {
        outboxMessageId: Schema.decodeUnknownSync(OutboxMessageId)(outbox?.outboxMessageId),
        outboundMessageId: Schema.decodeUnknownSync(OutboundChannelMessageId)(
          outbound?.outboundMessageId,
        ),
      };
    }).pipe(Effect.provide(fixtureClientLayer), Effect.scoped),
  );
  return row;
}

function recoveryInput(
  recoveryId: string,
  outboundMessageId: typeof OutboundChannelMessageId.Type,
) {
  return {
    recoveryId: Schema.decodeUnknownSync(TelegramDeliveryRecoveryId)(recoveryId),
    outboundMessageId,
    expectedErrorCode: Schema.decodeUnknownSync(TelegramDeliveryRecoveryExpectedErrorCode)(
      "telegram_http_400",
    ),
    reason: "recipient_state_corrected",
    maximumAttempts: policy.maximumAttempts,
  } as const;
}

describe("PostgreSQL Telegram delivery store", () => {
  beforeAll(async () => {
    await Effect.runPromise(testDatabase.recreate);
    await Effect.runPromise(runMigrations(testDatabase.migrationUrl));
  });

  afterAll(async () => {
    await Effect.runPromise(testDatabase.drop);
  });

  it("converges concurrent delivery on one durable provider attempt", async () => {
    const fixture = await createReplyFixture("9001");
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* TelegramDeliveryStore;
        return yield* Effect.all(
          [
            store.claim({ outboxMessageId: fixture.outboxMessageId, policy }),
            store.claim({ outboxMessageId: fixture.outboxMessageId, policy }),
          ],
          { concurrency: 2 },
        );
      }).pipe(Effect.provide(deliveryLayer), Effect.scoped),
    );

    expect(outcomes.map((outcome) => outcome._tag).toSorted()).toEqual(["Claimed", "Deferred"]);
  });

  it("persists explicit provider acceptance and suppresses redelivery", async () => {
    const fixture = await createReplyFixture("9002");
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* TelegramDeliveryStore;
        const claimed = yield* store.claim({ outboxMessageId: fixture.outboxMessageId, policy });
        if (claimed._tag !== "Claimed") {
          return { claimed, duplicate: claimed };
        }
        yield* store.completeAttempt({
          attemptId: claimed.attemptId,
          outboundMessageId: claimed.outboundMessageId,
          outcome: { _tag: "ProviderAccepted", providerMessageId: "811" },
        });
        const duplicate = yield* store.claim({
          outboxMessageId: fixture.outboxMessageId,
          policy,
        });
        return { claimed, duplicate };
      }).pipe(Effect.provide(deliveryLayer), Effect.scoped),
    );
    const [state] = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly attemptStatus: string;
          readonly providerMessageId: string;
          readonly status: string;
        }>`
          SELECT
            message.status,
            message.provider_message_id AS "providerMessageId",
            attempt.status AS "attemptStatus"
          FROM outbound_channel_messages AS message
          INNER JOIN channel_delivery_attempts AS attempt
            ON attempt.outbound_message_id = message.id
          WHERE message.id = ${fixture.outboundMessageId}
        `;
      }).pipe(Effect.provide(fixtureClientLayer), Effect.scoped),
    );

    expect(outcomes.claimed._tag).toBe("Claimed");
    expect(outcomes.duplicate).toEqual({ _tag: "Terminal" });
    expect(state).toEqual({
      status: "provider_accepted",
      providerMessageId: "811",
      attemptStatus: "provider_accepted",
    });
  });

  it("returns explicit transient failure to pending while outcome unknown is terminal", async () => {
    const transientFixture = await createReplyFixture("9003");
    const unknownFixture = await createReplyFixture("9004");
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* TelegramDeliveryStore;
        const transient = yield* store.claim({
          outboxMessageId: transientFixture.outboxMessageId,
          policy,
        });
        const unknown = yield* store.claim({
          outboxMessageId: unknownFixture.outboxMessageId,
          policy,
        });
        if (transient._tag !== "Claimed" || unknown._tag !== "Claimed") {
          return { transient, unknown, retried: transient, suppressed: unknown };
        }
        yield* store.completeAttempt({
          attemptId: transient.attemptId,
          outboundMessageId: transient.outboundMessageId,
          outcome: { _tag: "TransientFailure", errorCode: "telegram_http_429" },
        });
        yield* store.completeAttempt({
          attemptId: unknown.attemptId,
          outboundMessageId: unknown.outboundMessageId,
          outcome: { _tag: "OutcomeUnknown", errorCode: "network_outcome_unknown" },
        });
        const retried = yield* store.claim({
          outboxMessageId: transientFixture.outboxMessageId,
          policy,
        });
        const suppressed = yield* store.claim({
          outboxMessageId: unknownFixture.outboxMessageId,
          policy,
        });
        return { transient, unknown, retried, suppressed };
      }).pipe(Effect.provide(deliveryLayer), Effect.scoped),
    );

    expect(states.transient._tag).toBe("Claimed");
    expect(states.unknown._tag).toBe("Claimed");
    expect(states.retried._tag).toBe("Claimed");
    expect(states.suppressed).toEqual({ _tag: "Terminal" });
  });

  it("prepares one terminal rejection for idempotent operator redelivery", async () => {
    const fixture = await createReplyFixture("9005");
    const input = recoveryInput("github-run-9005", fixture.outboundMessageId);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const delivery = yield* TelegramDeliveryStore;
        const recovery = yield* TelegramDeliveryRecoveryStore;
        const claimed = yield* delivery.claim({ outboxMessageId: fixture.outboxMessageId, policy });
        if (claimed._tag !== "Claimed") {
          return yield* Effect.dieMessage("Expected the fixture delivery to be claimable");
        }
        yield* delivery.completeAttempt({
          attemptId: claimed.attemptId,
          outboundMessageId: claimed.outboundMessageId,
          outcome: { _tag: "TerminalFailure", errorCode: "telegram_http_400" },
        });
        const prepared = yield* recovery.prepare(input);
        const redelivery = yield* delivery.claim({
          outboxMessageId: fixture.outboxMessageId,
          policy,
        });
        const marked = yield* recovery.markPublished({ recoveryId: input.recoveryId });
        const replay = yield* recovery.prepare(input);
        return { claimed, prepared, redelivery, marked, replay };
      }).pipe(Effect.provide(deliveryAndRecoveryLayer), Effect.scoped),
    );

    expect(result.claimed._tag).toBe("Claimed");
    expect(result.prepared).toMatchObject({
      _tag: "Prepared",
      publicationStatus: "prepared",
      outboxMessageId: fixture.outboxMessageId,
    });
    expect(result.redelivery._tag).toBe("Claimed");
    expect(result.marked).toEqual({ _tag: "Published" });
    expect(result.replay).toMatchObject({
      _tag: "Prepared",
      publicationStatus: "published",
      outboxMessageId: fixture.outboxMessageId,
    });
  });

  it("never recovers an outcome-unknown provider attempt", async () => {
    const fixture = await createReplyFixture("9006");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const delivery = yield* TelegramDeliveryStore;
        const recovery = yield* TelegramDeliveryRecoveryStore;
        const claimed = yield* delivery.claim({ outboxMessageId: fixture.outboxMessageId, policy });
        if (claimed._tag !== "Claimed") {
          return { _tag: "Unexpected" } as const;
        }
        yield* delivery.completeAttempt({
          attemptId: claimed.attemptId,
          outboundMessageId: claimed.outboundMessageId,
          outcome: { _tag: "OutcomeUnknown", errorCode: "network_outcome_unknown" },
        });
        return yield* recovery.prepare(recoveryInput("github-run-9006", fixture.outboundMessageId));
      }).pipe(Effect.provide(deliveryAndRecoveryLayer), Effect.scoped),
    );

    expect(result).toEqual({ _tag: "NotRecoverable", reason: "outcome_unknown" });
  });

  it("allows no further operator retry after the provider-attempt ceiling", async () => {
    const fixture = await createReplyFixture("9007");
    const finalRecovery = await Effect.runPromise(
      Effect.gen(function* () {
        const delivery = yield* TelegramDeliveryStore;
        const recovery = yield* TelegramDeliveryRecoveryStore;

        for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
          const claimed = yield* delivery.claim({
            outboxMessageId: fixture.outboxMessageId,
            policy,
          });
          if (claimed._tag !== "Claimed") {
            return { _tag: "Unexpected", attemptNumber } as const;
          }
          yield* delivery.completeAttempt({
            attemptId: claimed.attemptId,
            outboundMessageId: claimed.outboundMessageId,
            outcome: { _tag: "TerminalFailure", errorCode: "telegram_http_400" },
          });
          if (attemptNumber < 3) {
            const recovered = yield* recovery.prepare(
              recoveryInput(`github-run-9007-${attemptNumber}`, fixture.outboundMessageId),
            );
            if (recovered._tag !== "Prepared") {
              return recovered;
            }
          }
        }

        return yield* recovery.prepare(
          recoveryInput("github-run-9007-3", fixture.outboundMessageId),
        );
      }).pipe(Effect.provide(deliveryAndRecoveryLayer), Effect.scoped),
    );

    expect(finalRecovery).toEqual({
      _tag: "NotRecoverable",
      reason: "attempt_limit_reached",
    });
  });

  it("distinguishes a missing recovery record from persistence unavailability", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const recovery = yield* TelegramDeliveryRecoveryStore;
        return yield* recovery.markPublished({
          recoveryId: Schema.decodeUnknownSync(TelegramDeliveryRecoveryId)(
            "github-run-missing-recovery",
          ),
        });
      }).pipe(Effect.provide(recoveryLayer), Effect.scoped),
    );

    expect(result).toEqual({ _tag: "NotFound" });
  });
});
