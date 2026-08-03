import type { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import type { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import { Context, Effect, Schema } from "effect";

import type { InboundEventId } from "./inbound-event.js";
import type {
  PersistedTelegramContent,
  PersistedTelegramEventV1,
  VerifiedTelegramUpdate,
} from "./telegram-event.js";
import { LinkChallengeCrypto, type LinkChallengeCryptoUnavailable } from "../identity/identity.js";

/** Deterministic idempotency key for accepting one Telegram update. */
export const TelegramIngressIdempotencyKey = Schema.String.pipe(
  Schema.pattern(/^telegram:update:[0-9]{1,20}$/),
  Schema.brand("TelegramIngressIdempotencyKey"),
);

/** Parsed Telegram ingress idempotency key. */
export type TelegramIngressIdempotencyKey = typeof TelegramIngressIdempotencyKey.Type;

/** Input accepted by the Telegram ingress application operation. */
export interface AcceptTelegramEventInput {
  readonly update: VerifiedTelegramUpdate;
  readonly correlationId: CorrelationId;
}

/** First durable acceptance of one Telegram update. */
export interface TelegramEventAccepted {
  readonly _tag: "Accepted";
  readonly inboundEventId: InboundEventId;
  readonly outboxMessageId: OutboxMessageId;
}

/** Provider redelivery of a Telegram update that is already durable. */
export interface TelegramEventDuplicate {
  readonly _tag: "Duplicate";
}

/** Observable result of Telegram ingress acceptance. */
export type AcceptTelegramEventOutcome = TelegramEventAccepted | TelegramEventDuplicate;

/** Application-shaped persistence command after challenge material is minimized. */
export interface PersistTelegramEventInput {
  readonly idempotencyKey: TelegramIngressIdempotencyKey;
  readonly correlationId: CorrelationId;
  readonly event: PersistedTelegramEventV1;
  readonly outboxKind: "channel.event.received.v1";
}

/** Expected infrastructure failure while durably accepting a Telegram update. */
export class TelegramIngressPersistenceUnavailable extends Schema.TaggedError<TelegramIngressPersistenceUnavailable>()(
  "TelegramIngressPersistenceUnavailable",
  {
    operation: Schema.Literal("connectTelegramIngress", "persistTelegramEvent"),
    reason: Schema.Literal("database_unavailable"),
  },
) {
  /** Safe description that omits provider payload and database detail. */
  override get message(): string {
    return "Telegram ingress persistence is unavailable";
  }
}

/** Persistence capability required by authenticated Telegram ingress. */
export interface TelegramIngressStoreService {
  /** Atomically persist the normalized event and dispatch outbox record. */
  readonly persist: (
    input: PersistTelegramEventInput,
  ) => Effect.Effect<AcceptTelegramEventOutcome, TelegramIngressPersistenceUnavailable>;
}

/** Authority seam for durable Telegram ingress acceptance. */
export class TelegramIngressStore extends Context.Tag(
  "@xpensego/domain/channel/TelegramIngressStore",
)<TelegramIngressStore, TelegramIngressStoreService>() {}

function minimizeContent(
  content: VerifiedTelegramUpdate["content"],
): Effect.Effect<PersistedTelegramContent, LinkChallengeCryptoUnavailable, LinkChallengeCrypto> {
  switch (content._tag) {
    case "Text":
      return Effect.succeed(content);
    case "InvalidCommand":
      return Effect.succeed(content);
    case "LinkCommand":
    case "UnlinkCommand":
      return Effect.gen(function* () {
        const crypto = yield* LinkChallengeCrypto;
        const challengeDigest = yield* crypto.digestToken(content.token);
        return { _tag: content._tag, challengeDigest } as const;
      });
  }
}

/**
 * Minimize and atomically accept one authenticated Telegram provider event.
 *
 * @param input - Verified update and server-generated correlation identifier.
 * @returns Accepted or duplicate after durable event and outbox persistence.
 */
export const acceptTelegramEvent = Effect.fn("Channel.acceptTelegramEvent")(function* (
  input: AcceptTelegramEventInput,
) {
  const store = yield* TelegramIngressStore;
  const content = yield* minimizeContent(input.update.content);
  const idempotencyKey = TelegramIngressIdempotencyKey.make(
    `telegram:update:${input.update.updateId}`,
  );
  const event = {
    version: 1,
    updateId: input.update.updateId,
    externalAccountId: input.update.externalAccountId,
    externalConversationId: input.update.externalConversationId,
    externalMessageId: input.update.externalMessageId,
    occurredAtMillis: input.update.occurredAtMillis,
    content,
  } satisfies PersistedTelegramEventV1;

  return yield* store.persist({
    idempotencyKey,
    correlationId: input.correlationId,
    event,
    outboxKind: "channel.event.received.v1",
  });
});
