import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import {
  OutboxPublication,
  OutboxPublicationUnavailable,
} from "@xpensego/domain/outbox/outbox-delivery";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { OutboundChannelMessageId } from "./outbound-channel-intent.js";
import {
  TelegramDeliveryRecoveryExpectedErrorCode,
  TelegramDeliveryRecoveryId,
  TelegramDeliveryRecoveryStateConflict,
  TelegramDeliveryRecoveryStore,
  recoverTelegramDelivery,
  type TelegramDeliveryRecoveryStoreService,
} from "./recover-telegram-delivery.js";

const recoveryId = Schema.decodeUnknownSync(TelegramDeliveryRecoveryId)("github-run-30795443712");
const outboundMessageId = Schema.decodeUnknownSync(OutboundChannelMessageId)(
  "5a29987f-c69f-46c1-bfd7-e2074f5fc491",
);
const outboxMessageId = Schema.decodeUnknownSync(OutboxMessageId)(
  "b0602d7f-7d76-4f81-a896-62751c76631c",
);
const correlationId = Schema.decodeUnknownSync(CorrelationId)(
  "2dd4a9ce-0b85-4904-8808-8bb447748cd1",
);
const input = {
  recoveryId,
  outboundMessageId,
  expectedErrorCode: Schema.decodeUnknownSync(TelegramDeliveryRecoveryExpectedErrorCode)(
    "telegram_http_400",
  ),
  reason: "recipient_state_corrected",
} as const;

function runRecovery(
  store: TelegramDeliveryRecoveryStoreService,
  publish: Parameters<typeof OutboxPublication.of>[0]["publish"],
) {
  return recoverTelegramDelivery(input).pipe(
    Effect.provide(
      Layer.merge(
        Layer.succeed(TelegramDeliveryRecoveryStore, TelegramDeliveryRecoveryStore.of(store)),
        Layer.succeed(OutboxPublication, OutboxPublication.of({ publish })),
      ),
    ),
  );
}

describe("Telegram delivery recovery", () => {
  it("publishes a prepared recovery and marks its durable publication", async () => {
    const published: Array<typeof outboxMessageId> = [];
    const marked: Array<typeof recoveryId> = [];

    const result = await Effect.runPromise(
      runRecovery(
        {
          prepare: () =>
            Effect.succeed({
              _tag: "Prepared",
              publicationStatus: "prepared",
              outboxMessageId,
              correlationId,
            }),
          markPublished: ({ recoveryId: preparedRecoveryId }) =>
            Effect.sync(() => {
              marked.push(preparedRecoveryId);
              return { _tag: "Published" } as const;
            }),
        },
        ({ outboxMessageId: publishedOutboxMessageId }) =>
          Effect.sync(() => {
            published.push(publishedOutboxMessageId);
          }),
      ),
    );

    expect(result).toEqual({ _tag: "Recovered", publication: "published" });
    expect(published).toEqual([outboxMessageId]);
    expect(marked).toEqual([recoveryId]);
  });

  it("returns a durable refusal without publishing", async () => {
    const published: Array<typeof outboxMessageId> = [];

    const result = await Effect.runPromise(
      runRecovery(
        {
          prepare: () => Effect.succeed({ _tag: "NotRecoverable", reason: "outcome_unknown" }),
          markPublished: () => Effect.succeed({ _tag: "Published" }),
        },
        ({ outboxMessageId: publishedOutboxMessageId }) =>
          Effect.sync(() => {
            published.push(publishedOutboxMessageId);
          }),
      ),
    );

    expect(result).toEqual({ _tag: "NotRecoverable", reason: "outcome_unknown" });
    expect(published).toEqual([]);
  });

  it("does not republish an idempotent recovery already accepted by Queue", async () => {
    const published: Array<typeof outboxMessageId> = [];

    const result = await Effect.runPromise(
      runRecovery(
        {
          prepare: () =>
            Effect.succeed({
              _tag: "Prepared",
              publicationStatus: "published",
              outboxMessageId,
              correlationId,
            }),
          markPublished: () => Effect.succeed({ _tag: "Published" }),
        },
        ({ outboxMessageId: publishedOutboxMessageId }) =>
          Effect.sync(() => {
            published.push(publishedOutboxMessageId);
          }),
      ),
    );

    expect(result).toEqual({ _tag: "Recovered", publication: "already_published" });
    expect(published).toEqual([]);
  });

  it("leaves preparation recoverable when Queue publication fails", async () => {
    const marked: Array<typeof recoveryId> = [];

    const error = await Effect.runPromise(
      runRecovery(
        {
          prepare: () =>
            Effect.succeed({
              _tag: "Prepared",
              publicationStatus: "prepared",
              outboxMessageId,
              correlationId,
            }),
          markPublished: ({ recoveryId: preparedRecoveryId }) =>
            Effect.sync(() => {
              marked.push(preparedRecoveryId);
              return { _tag: "Published" } as const;
            }),
        },
        () =>
          Effect.fail(
            new OutboxPublicationUnavailable({
              operation: "publishOutboxMessage",
              outboxMessageId,
              reason: "queue_request_failed",
            }),
          ),
      ).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(OutboxPublicationUnavailable);
    expect(marked).toEqual([]);
  });

  it("reports a state conflict when the durable recovery disappears after publication", async () => {
    const error = await Effect.runPromise(
      runRecovery(
        {
          prepare: () =>
            Effect.succeed({
              _tag: "Prepared",
              publicationStatus: "prepared",
              outboxMessageId,
              correlationId,
            }),
          markPublished: () => Effect.succeed({ _tag: "NotFound" }),
        },
        () => Effect.void,
      ).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(TelegramDeliveryRecoveryStateConflict);
  });
});
