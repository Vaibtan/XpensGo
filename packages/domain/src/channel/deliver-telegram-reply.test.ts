import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import { Effect, Layer, Ref, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  TelegramBotApi,
  TelegramDeliveryStore,
  TelegramProviderOutcomeUnknown,
  TelegramProviderTransientFailure,
  TelegramReplyDeliveryDeferred,
  deliverTelegramReply,
  type TelegramDeliveryStoreService,
  type TelegramProviderAttemptOutcome,
} from "./deliver-telegram-reply.js";
import { ChannelDeliveryAttemptId, OutboundChannelMessageId } from "./outbound-channel-intent.js";
import { TelegramConversationId } from "./telegram-event.js";

const ids = {
  outboxMessageId: Schema.decodeUnknownSync(OutboxMessageId)(
    "b65a580c-ac48-48b2-856d-d4b69494fa47",
  ),
  outboundMessageId: Schema.decodeUnknownSync(OutboundChannelMessageId)(
    "59ffc071-7af5-47f0-998b-80e54642acd8",
  ),
  attemptId: Schema.decodeUnknownSync(ChannelDeliveryAttemptId)(
    "2eef8c16-8d16-4dd9-927a-7570e709020d",
  ),
  conversationId: Schema.decodeUnknownSync(TelegramConversationId)("123456"),
} as const;
const intent = {
  version: 1,
  channel: "telegram",
  purpose: "system",
  privacy: "private",
  content: { _tag: "LinkRequired" },
  actions: [{ _tag: "OpenWeb", path: "/workspace" }],
} as const;

function claimedStore(
  completeAttempt: TelegramDeliveryStoreService["completeAttempt"],
): TelegramDeliveryStoreService {
  return {
    claim: () =>
      Effect.succeed({
        _tag: "Claimed" as const,
        attemptId: ids.attemptId,
        outboundMessageId: ids.outboundMessageId,
        externalConversationId: ids.conversationId,
        intent,
      }),
    completeAttempt,
  };
}

describe("deliver Telegram reply", () => {
  it("defers before claiming an attempt when provider configuration is unavailable", async () => {
    const result = await Effect.runPromise(
      deliverTelegramReply({ outboxMessageId: ids.outboxMessageId }).pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(
              TelegramDeliveryStore,
              TelegramDeliveryStore.of({
                claim: () => Effect.die("provider readiness must be checked first"),
                completeAttempt: () => Effect.die("no attempt was claimed"),
              }),
            ),
            Layer.succeed(
              TelegramBotApi,
              TelegramBotApi.of({
                ensureAvailable: () =>
                  Effect.fail(
                    new TelegramProviderTransientFailure({
                      errorCode: "provider_configuration_unavailable",
                    }),
                  ),
                send: () => Effect.die("provider call must not run"),
              }),
            ),
          ),
        ),
        Effect.either,
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(TelegramReplyDeliveryDeferred);
    }
  });

  it("records explicit provider acceptance before returning delivered", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const outcome = yield* Ref.make<TelegramProviderAttemptOutcome | undefined>(undefined);
        const program = deliverTelegramReply({ outboxMessageId: ids.outboxMessageId }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(
                TelegramDeliveryStore,
                TelegramDeliveryStore.of(claimedStore((input) => Ref.set(outcome, input.outcome))),
              ),
              Layer.succeed(
                TelegramBotApi,
                TelegramBotApi.of({
                  ensureAvailable: () => Effect.void,
                  send: () => Effect.succeed({ providerMessageId: "811" }),
                }),
              ),
            ),
          ),
        );
        const delivered = yield* program;
        return { delivered, outcome: yield* Ref.get(outcome) };
      }),
    );

    expect(result).toEqual({
      delivered: { _tag: "ProviderAccepted" },
      outcome: { _tag: "ProviderAccepted", providerMessageId: "811" },
    });
  });

  it("records an ambiguous provider result as terminal outcome unknown", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const outcome = yield* Ref.make<TelegramProviderAttemptOutcome | undefined>(undefined);
        const delivered = yield* deliverTelegramReply({
          outboxMessageId: ids.outboxMessageId,
        }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(
                TelegramDeliveryStore,
                TelegramDeliveryStore.of(claimedStore((input) => Ref.set(outcome, input.outcome))),
              ),
              Layer.succeed(
                TelegramBotApi,
                TelegramBotApi.of({
                  ensureAvailable: () => Effect.void,
                  send: () =>
                    Effect.fail(
                      new TelegramProviderOutcomeUnknown({
                        errorCode: "network_outcome_unknown",
                      }),
                    ),
                }),
              ),
            ),
          ),
        );
        return { delivered, outcome: yield* Ref.get(outcome) };
      }),
    );

    expect(result).toEqual({
      delivered: { _tag: "OutcomeUnknown" },
      outcome: { _tag: "OutcomeUnknown", errorCode: "network_outcome_unknown" },
    });
  });

  it("records explicit transient rejection before returning a typed retry signal", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const outcome = yield* Ref.make<TelegramProviderAttemptOutcome | undefined>(undefined);
        const delivered = yield* deliverTelegramReply({
          outboxMessageId: ids.outboxMessageId,
        }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(
                TelegramDeliveryStore,
                TelegramDeliveryStore.of(claimedStore((input) => Ref.set(outcome, input.outcome))),
              ),
              Layer.succeed(
                TelegramBotApi,
                TelegramBotApi.of({
                  ensureAvailable: () => Effect.void,
                  send: () =>
                    Effect.fail(
                      new TelegramProviderTransientFailure({
                        errorCode: "telegram_http_429",
                      }),
                    ),
                }),
              ),
            ),
          ),
          Effect.either,
        );
        return { delivered, outcome: yield* Ref.get(outcome) };
      }),
    );

    expect(result.delivered._tag).toBe("Left");
    if (result.delivered._tag === "Left") {
      expect(result.delivered.left).toBeInstanceOf(TelegramReplyDeliveryDeferred);
    }
    expect(result.outcome).toEqual({
      _tag: "TransientFailure",
      errorCode: "telegram_http_429",
    });
  });
});
