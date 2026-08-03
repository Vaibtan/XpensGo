import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import { Effect, Layer, Redacted, Ref, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  TelegramIngressStore,
  acceptTelegramEvent,
  type PersistTelegramEventInput,
} from "./accept-telegram-event.js";
import {
  TelegramConversationId,
  TelegramMessageId,
  TelegramUpdateId,
  type VerifiedTelegramUpdate,
} from "./telegram-event.js";
import { InboundEventId } from "./inbound-event.js";
import {
  ChannelLinkChallengeDigest,
  ChannelLinkChallengeToken,
  TelegramExternalAccountId,
} from "../identity/channel-identity.js";
import { LinkChallengeCrypto } from "../identity/identity.js";

const correlationId = Schema.decodeUnknownSync(CorrelationId)(
  "bfda0c22-5be5-44c0-9c27-85ea19be7121",
);

function verifiedLinkUpdate(): VerifiedTelegramUpdate {
  return {
    updateId: Schema.decodeUnknownSync(TelegramUpdateId)("8183"),
    externalAccountId: Schema.decodeUnknownSync(TelegramExternalAccountId)("123456"),
    externalConversationId: Schema.decodeUnknownSync(TelegramConversationId)("123456"),
    externalMessageId: Schema.decodeUnknownSync(TelegramMessageId)("101"),
    occurredAtMillis: 1_785_638_402_000,
    content: {
      _tag: "LinkCommand",
      token: Redacted.make(Schema.decodeUnknownSync(ChannelLinkChallengeToken)("a".repeat(43))),
    },
  };
}

describe("accept Telegram event", () => {
  it("hashes challenge material and derives provider-scoped idempotency before persistence", async () => {
    const persisted = await Effect.runPromise(
      Effect.gen(function* () {
        const captured = yield* Ref.make<PersistTelegramEventInput | undefined>(undefined);
        const ingressLayer = Layer.succeed(
          TelegramIngressStore,
          TelegramIngressStore.of({
            persist: (input) =>
              Ref.set(captured, input).pipe(
                Effect.as({
                  _tag: "Accepted",
                  inboundEventId: Schema.decodeUnknownSync(InboundEventId)(
                    "7e104e94-a209-4627-8102-070e4d39bded",
                  ),
                  outboxMessageId: Schema.decodeUnknownSync(OutboxMessageId)(
                    "b65a580c-ac48-48b2-856d-d4b69494fa47",
                  ),
                } as const),
              ),
          }),
        );
        const cryptoLayer = Layer.succeed(
          LinkChallengeCrypto,
          LinkChallengeCrypto.of({
            generateToken: Effect.die("not required by inbound acceptance"),
            digestToken: () =>
              Effect.succeed(Schema.decodeUnknownSync(ChannelLinkChallengeDigest)("b".repeat(64))),
          }),
        );

        yield* acceptTelegramEvent({ update: verifiedLinkUpdate(), correlationId }).pipe(
          Effect.provide(Layer.merge(ingressLayer, cryptoLayer)),
        );
        return yield* Ref.get(captured);
      }),
    );

    expect(persisted).toMatchObject({
      idempotencyKey: "telegram:update:8183",
      event: {
        version: 1,
        updateId: "8183",
        content: { _tag: "LinkCommand", challengeDigest: "b".repeat(64) },
      },
    });
    expect(JSON.stringify(persisted)).not.toContain("a".repeat(43));
  });
});
