import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { acceptTelegramEvent } from "@xpensego/domain/channel/accept-telegram-event";
import {
  TelegramEventProcessingStore,
  TelegramPerIdentityRateLimit,
  TelegramProcessingLeaseSeconds,
  TelegramSystemRateLimit,
  processTelegramEvent,
} from "@xpensego/domain/channel/process-telegram-event";
import {
  TelegramConversationId,
  TelegramMessageId,
  TelegramMessageText,
  TelegramUpdateId,
  type VerifiedTelegramUpdate,
} from "@xpensego/domain/channel/telegram-event";
import { TelegramExternalAccountId } from "@xpensego/domain/identity/channel-identity";
import { UserId } from "@xpensego/domain/identity/user-id";
import { Effect, Layer, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makePostgresIdentityStoreLayer } from "./identity-store.js";
import { makeIsolatedTestDatabase } from "./isolated-test-database.js";
import { runMigrations } from "./migrations.js";
import { makePostgresTelegramEventProcessingStoreLayer } from "./telegram-event-processing-store.js";
import { makePostgresTelegramIngressStoreLayer } from "./telegram-ingress-store.js";
import { webCryptoLinkChallengeLayer } from "../web-crypto/link-challenge-crypto.js";

const testDatabase = makeIsolatedTestDatabase("xpensego_telegram_processing_integration");
const fixtureClientLayer = PgClient.layer({
  url: testDatabase.migrationUrl,
  applicationName: "xpensego-telegram-processing-fixtures",
  maxConnections: 1,
});
const correlationId = Schema.decodeUnknownSync(CorrelationId)(
  "bfda0c22-5be5-44c0-9c27-85ea19be7121",
);

function telegramTextUpdate(
  updateId: string,
  externalAccountId = "123456",
): VerifiedTelegramUpdate {
  return {
    updateId: Schema.decodeUnknownSync(TelegramUpdateId)(updateId),
    externalAccountId: Schema.decodeUnknownSync(TelegramExternalAccountId)(externalAccountId),
    externalConversationId: Schema.decodeUnknownSync(TelegramConversationId)(externalAccountId),
    externalMessageId: Schema.decodeUnknownSync(TelegramMessageId)(updateId),
    occurredAtMillis: 1_785_638_402_000,
    content: {
      _tag: "Text",
      text: Schema.decodeUnknownSync(TelegramMessageText)("Spent 250 on lunch"),
    },
  };
}

const ingressLayer = Layer.merge(
  makePostgresTelegramIngressStoreLayer(testDatabase.runtimeUrl),
  webCryptoLinkChallengeLayer,
);
const processingStoreLayer = makePostgresTelegramEventProcessingStoreLayer(testDatabase.runtimeUrl);
const processingLayer = Layer.merge(
  processingStoreLayer,
  makePostgresIdentityStoreLayer(testDatabase.runtimeUrl),
);

async function accept(update: VerifiedTelegramUpdate) {
  return Effect.runPromise(
    acceptTelegramEvent({ update, correlationId }).pipe(
      Effect.provide(ingressLayer),
      Effect.scoped,
    ),
  );
}

describe("PostgreSQL Telegram event processing store", () => {
  beforeAll(async () => {
    await Effect.runPromise(testDatabase.recreate);
    await Effect.runPromise(runMigrations(testDatabase.migrationUrl));
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          WITH inserted_user AS (
            INSERT INTO users DEFAULT VALUES
            RETURNING id
          ), inserted_ledger AS (
            INSERT INTO ledgers (owner_user_id)
            SELECT id FROM inserted_user
            RETURNING id, owner_user_id
          )
          INSERT INTO channel_identities (
            user_id,
            ledger_id,
            channel,
            external_account_id
          )
          SELECT owner_user_id, id, 'telegram', '123456'
          FROM inserted_ledger
        `;
      }).pipe(Effect.provide(fixtureClientLayer), Effect.scoped),
    );
  });

  afterAll(async () => {
    await Effect.runPromise(testDatabase.drop);
  });

  it("scopes linked text and atomically creates one normalized command and durable reply", async () => {
    const accepted = await accept(telegramTextUpdate("8183"));
    expect(accepted._tag).toBe("Accepted");
    if (accepted._tag !== "Accepted") {
      return;
    }

    const first = await Effect.runPromise(
      processTelegramEvent({
        outboxMessageId: accepted.outboxMessageId,
        correlationId,
      }).pipe(Effect.provide(processingLayer), Effect.scoped),
    );
    const duplicate = await Effect.runPromise(
      processTelegramEvent({
        outboxMessageId: accepted.outboxMessageId,
        correlationId,
      }).pipe(Effect.provide(processingLayer), Effect.scoped),
    );
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{
          readonly commandCount: number;
          readonly commandText: string;
          readonly eventStatus: string;
          readonly ownerUserId: string | null;
          readonly replyCount: number;
          readonly replyOutboxCount: number;
          readonly replyStatus: string;
        }>`
          SELECT
            event.processing_status AS "eventStatus",
            event.owner_user_id AS "ownerUserId",
            (SELECT count(*)::integer FROM normalized_channel_commands)
              AS "commandCount",
            (SELECT command_text FROM normalized_channel_commands LIMIT 1)
              AS "commandText",
            (SELECT count(*)::integer FROM outbound_channel_messages)
              AS "replyCount",
            (SELECT status FROM outbound_channel_messages LIMIT 1)
              AS "replyStatus",
            (
              SELECT count(*)::integer
              FROM outbox_messages
              WHERE kind = 'channel.reply.requested.v1'
            ) AS "replyOutboxCount"
          FROM inbound_channel_events AS event
          WHERE event.id = ${accepted.inboundEventId}
        `;
        return row;
      }).pipe(Effect.provide(fixtureClientLayer), Effect.scoped),
    );

    expect(first._tag).toBe("Processed");
    expect(duplicate).toEqual({ _tag: "Duplicate" });
    expect(state).toMatchObject({
      eventStatus: "processed",
      commandCount: 1,
      commandText: "Spent 250 on lunch",
      replyCount: 1,
      replyStatus: "pending",
      replyOutboxCount: 1,
    });
    expect(state?.ownerUserId).not.toBeNull();
  });

  it("allows only one active processing lease for concurrent Queue delivery", async () => {
    const accepted = await accept(telegramTextUpdate("8184"));
    expect(accepted._tag).toBe("Accepted");
    if (accepted._tag !== "Accepted") {
      return;
    }

    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* TelegramEventProcessingStore;
        return yield* Effect.all(
          [
            store.claim({
              outboxMessageId: accepted.outboxMessageId,
              policy: {
                perIdentityPerMinute: TelegramPerIdentityRateLimit.make(30),
                systemPerMinute: TelegramSystemRateLimit.make(300),
                leaseSeconds: TelegramProcessingLeaseSeconds.make(60),
              },
            }),
            store.claim({
              outboxMessageId: accepted.outboxMessageId,
              policy: {
                perIdentityPerMinute: TelegramPerIdentityRateLimit.make(30),
                systemPerMinute: TelegramSystemRateLimit.make(300),
                leaseSeconds: TelegramProcessingLeaseSeconds.make(60),
              },
            }),
          ],
          { concurrency: 2 },
        );
      }).pipe(Effect.provide(processingStoreLayer), Effect.scoped),
    );

    expect(outcomes.map((outcome) => outcome._tag).toSorted()).toEqual(["Claimed", "Deferred"]);
  });

  it("persists per-identity abuse suppression once and creates no reply", async () => {
    const first = await accept(telegramTextUpdate("8185", "999999"));
    const second = await accept(telegramTextUpdate("8186", "999999"));
    expect(first._tag).toBe("Accepted");
    expect(second._tag).toBe("Accepted");
    if (first._tag !== "Accepted" || second._tag !== "Accepted") {
      return;
    }

    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* TelegramEventProcessingStore;
        const policy = {
          perIdentityPerMinute: TelegramPerIdentityRateLimit.make(1),
          systemPerMinute: TelegramSystemRateLimit.make(100),
          leaseSeconds: TelegramProcessingLeaseSeconds.make(60),
        } as const;
        const firstClaim = yield* store.claim({ outboxMessageId: first.outboxMessageId, policy });
        if (firstClaim._tag === "Claimed") {
          yield* store.release({
            claimId: firstClaim.claimId,
            inboundEventId: firstClaim.inboundEventId,
          });
        }
        const secondClaim = yield* store.claim({
          outboxMessageId: second.outboxMessageId,
          policy,
        });
        return { firstClaim, secondClaim };
      }).pipe(Effect.provide(processingStoreLayer), Effect.scoped),
    );
    const [suppressed] = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{
          readonly processingOutcome: string;
          readonly processingStatus: string;
        }>`
          SELECT
            processing_status AS "processingStatus",
            processing_outcome AS "processingOutcome"
          FROM inbound_channel_events
          WHERE id = ${second.inboundEventId}
        `;
      }).pipe(Effect.provide(fixtureClientLayer), Effect.scoped),
    );

    expect(outcomes.firstClaim._tag).toBe("Claimed");
    expect(outcomes.secondClaim).toEqual({ _tag: "RateLimited" });
    expect(suppressed).toEqual({
      processingStatus: "suppressed",
      processingOutcome: "abuse_limited",
    });
  });

  it("enforces one linked User window across multiple Telegram identities", async () => {
    const userId = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{ readonly userId: unknown }>`
          WITH inserted_user AS (
            INSERT INTO users DEFAULT VALUES
            RETURNING id
          ), inserted_ledger AS (
            INSERT INTO ledgers (owner_user_id)
            SELECT id FROM inserted_user
            RETURNING id, owner_user_id
          ), inserted_identities AS (
            INSERT INTO channel_identities (
              user_id,
              ledger_id,
              channel,
              external_account_id
            )
            SELECT owner_user_id, id, 'telegram', identity.external_account_id
            FROM inserted_ledger
            CROSS JOIN (VALUES ('888881'), ('888882')) AS identity(external_account_id)
          )
          SELECT id AS "userId" FROM inserted_user
        `;
        return yield* Schema.decodeUnknown(UserId)(row?.userId);
      }).pipe(Effect.provide(fixtureClientLayer), Effect.scoped),
    );
    const first = await accept(telegramTextUpdate("8187", "888881"));
    const second = await accept(telegramTextUpdate("8188", "888882"));
    expect(first._tag).toBe("Accepted");
    expect(second._tag).toBe("Accepted");
    if (first._tag !== "Accepted" || second._tag !== "Accepted") {
      return;
    }

    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* TelegramEventProcessingStore;
        const policy = {
          perIdentityPerMinute: TelegramPerIdentityRateLimit.make(30),
          systemPerMinute: TelegramSystemRateLimit.make(300),
          leaseSeconds: TelegramProcessingLeaseSeconds.make(60),
        } as const;
        const firstClaim = yield* store.claim({ outboxMessageId: first.outboxMessageId, policy });
        const secondClaim = yield* store.claim({
          outboxMessageId: second.outboxMessageId,
          policy,
        });
        if (firstClaim._tag !== "Claimed" || secondClaim._tag !== "Claimed") {
          return { firstClaim, secondClaim, firstUser: undefined, secondUser: undefined };
        }
        const firstUser = yield* store.enforceUserLimit({
          claimId: firstClaim.claimId,
          inboundEventId: firstClaim.inboundEventId,
          userId,
          maximumEventsPerMinute: TelegramPerIdentityRateLimit.make(1),
        });
        const secondUser = yield* store.enforceUserLimit({
          claimId: secondClaim.claimId,
          inboundEventId: secondClaim.inboundEventId,
          userId,
          maximumEventsPerMinute: TelegramPerIdentityRateLimit.make(1),
        });
        return { firstClaim, secondClaim, firstUser, secondUser };
      }).pipe(Effect.provide(processingStoreLayer), Effect.scoped),
    );

    expect(outcomes.firstClaim._tag).toBe("Claimed");
    expect(outcomes.secondClaim._tag).toBe("Claimed");
    expect(outcomes.firstUser).toEqual({ _tag: "Allowed" });
    expect(outcomes.secondUser).toEqual({ _tag: "RateLimited" });
  });
});
