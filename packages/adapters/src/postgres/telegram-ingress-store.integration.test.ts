import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { acceptTelegramEvent } from "@xpensego/domain/channel/accept-telegram-event";
import {
  TelegramConversationId,
  TelegramMessageId,
  TelegramMessageText,
  TelegramUpdateId,
  type VerifiedTelegramUpdate,
} from "@xpensego/domain/channel/telegram-event";
import { TelegramExternalAccountId } from "@xpensego/domain/identity/channel-identity";
import { Effect, Layer, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeIsolatedTestDatabase } from "./isolated-test-database.js";
import { runMigrations } from "./migrations.js";
import { makePostgresTelegramIngressStoreLayer } from "./telegram-ingress-store.js";
import { webCryptoLinkChallengeLayer } from "../web-crypto/link-challenge-crypto.js";

const testDatabase = makeIsolatedTestDatabase("xpensego_telegram_ingress_integration");
const migrationClientLayer = PgClient.layer({
  url: testDatabase.migrationUrl,
  applicationName: "xpensego-telegram-ingress-fixtures",
  maxConnections: 1,
});
const correlationId = Schema.decodeUnknownSync(CorrelationId)(
  "bfda0c22-5be5-44c0-9c27-85ea19be7121",
);
const update: VerifiedTelegramUpdate = {
  updateId: Schema.decodeUnknownSync(TelegramUpdateId)("8183"),
  externalAccountId: Schema.decodeUnknownSync(TelegramExternalAccountId)("123456"),
  externalConversationId: Schema.decodeUnknownSync(TelegramConversationId)("123456"),
  externalMessageId: Schema.decodeUnknownSync(TelegramMessageId)("101"),
  occurredAtMillis: 1_785_638_402_000,
  content: {
    _tag: "Text",
    text: Schema.decodeUnknownSync(TelegramMessageText)("Spent 250 on lunch"),
  },
};

const readIngressState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    readonly eventCount: number;
    readonly outboxCount: number;
    readonly ownerUserId: string | null;
    readonly ledgerId: string | null;
    readonly normalizedPayload: unknown;
    readonly processingStatus: string;
  }>`
    SELECT
      (SELECT count(*)::integer FROM inbound_channel_events) AS "eventCount",
      (SELECT count(*)::integer FROM outbox_messages) AS "outboxCount",
      event.owner_user_id AS "ownerUserId",
      event.ledger_id AS "ledgerId",
      event.normalized_payload AS "normalizedPayload",
      event.processing_status AS "processingStatus"
    FROM inbound_channel_events AS event
    LIMIT 1
  `;
  return row;
}).pipe(Effect.provide(migrationClientLayer), Effect.scoped);

describe("PostgreSQL Telegram ingress store", () => {
  beforeAll(async () => {
    await Effect.runPromise(testDatabase.recreate);
    await Effect.runPromise(runMigrations(testDatabase.migrationUrl));
  });

  afterAll(async () => {
    await Effect.runPromise(testDatabase.drop);
  });

  it("converges concurrent Telegram redelivery on one normalized event and dispatch", async () => {
    const ingressLayer = makePostgresTelegramIngressStoreLayer(testDatabase.runtimeUrl);
    const outcomes = await Effect.runPromise(
      Effect.all(
        [
          acceptTelegramEvent({ update, correlationId }),
          acceptTelegramEvent({ update, correlationId }),
        ],
        { concurrency: 2 },
      ).pipe(Effect.provide(Layer.merge(ingressLayer, webCryptoLinkChallengeLayer)), Effect.scoped),
    );

    expect(outcomes.map((outcome) => outcome._tag).toSorted()).toEqual(["Accepted", "Duplicate"]);
    await expect(Effect.runPromise(readIngressState)).resolves.toEqual({
      eventCount: 1,
      outboxCount: 1,
      ownerUserId: null,
      ledgerId: null,
      processingStatus: "pending",
      normalizedPayload: {
        version: 1,
        updateId: "8183",
        externalAccountId: "123456",
        externalConversationId: "123456",
        externalMessageId: "101",
        occurredAtMillis: 1_785_638_402_000,
        content: { _tag: "Text", text: "Spent 250 on lunch" },
      },
    });
  });
});
