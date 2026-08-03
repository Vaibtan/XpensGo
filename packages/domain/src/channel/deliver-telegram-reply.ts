import type { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import { Context, Effect, Schema } from "effect";

import {
  ChannelDeliveryAttemptId,
  OutboundChannelMessageId,
  type TelegramReplyIntentV1,
} from "./outbound-channel-intent.js";
import type { TelegramConversationId } from "./telegram-event.js";

/** Maximum explicit provider attempts before a reply becomes terminal. */
export const TelegramMaximumDeliveryAttempts = Schema.Int.pipe(
  Schema.between(1, 10),
  Schema.brand("TelegramMaximumDeliveryAttempts"),
);

/** Seconds for which one Queue delivery owns a provider attempt. */
export const TelegramDeliveryLeaseSeconds = Schema.Int.pipe(
  Schema.between(10, 300),
  Schema.brand("TelegramDeliveryLeaseSeconds"),
);

/** Parsed maximum delivery attempts. */
export type TelegramMaximumDeliveryAttempts = typeof TelegramMaximumDeliveryAttempts.Type;

/** Parsed delivery lease duration. */
export type TelegramDeliveryLeaseSeconds = typeof TelegramDeliveryLeaseSeconds.Type;

/** Bounded delivery policy. */
export interface TelegramDeliveryPolicy {
  readonly maximumAttempts: TelegramMaximumDeliveryAttempts;
  readonly leaseSeconds: TelegramDeliveryLeaseSeconds;
}

/** Conservative alpha delivery policy. */
export const defaultTelegramDeliveryPolicy: TelegramDeliveryPolicy = {
  maximumAttempts: TelegramMaximumDeliveryAttempts.make(3),
  leaseSeconds: TelegramDeliveryLeaseSeconds.make(60),
};

/** Provider-bound reply leased from durable persistence. */
export interface TelegramReplyClaimed {
  readonly _tag: "Claimed";
  readonly attemptId: ChannelDeliveryAttemptId;
  readonly outboundMessageId: OutboundChannelMessageId;
  readonly externalConversationId: TelegramConversationId;
  readonly intent: TelegramReplyIntentV1;
}

/** Observable result of claiming one reply outbox message. */
export type ClaimTelegramReplyOutcome =
  | TelegramReplyClaimed
  | { readonly _tag: "Terminal" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Deferred"; readonly retryAfterSeconds: number };

/** Typed result persisted after a provider attempt. */
export type TelegramProviderAttemptOutcome =
  | { readonly _tag: "ProviderAccepted"; readonly providerMessageId: string }
  | { readonly _tag: "TransientFailure"; readonly errorCode: string }
  | { readonly _tag: "TerminalFailure"; readonly errorCode: string }
  | { readonly _tag: "OutcomeUnknown"; readonly errorCode: string };

/** Expected persistence failure around provider delivery state. */
export class TelegramDeliveryPersistenceUnavailable extends Schema.TaggedError<TelegramDeliveryPersistenceUnavailable>()(
  "TelegramDeliveryPersistenceUnavailable",
  {
    operation: Schema.Literal(
      "claimTelegramReply",
      "completeTelegramReplyAttempt",
      "connectTelegramDelivery",
    ),
    reason: Schema.Literal("database_unavailable"),
  },
) {
  /** Safe infrastructure description. */
  override get message(): string {
    return "Telegram delivery persistence is unavailable";
  }
}

/** Persistence authority for provider-attempt claims and outcomes. */
export interface TelegramDeliveryStoreService {
  readonly claim: (input: {
    readonly outboxMessageId: OutboxMessageId;
    readonly policy: TelegramDeliveryPolicy;
  }) => Effect.Effect<ClaimTelegramReplyOutcome, TelegramDeliveryPersistenceUnavailable>;

  readonly completeAttempt: (input: {
    readonly attemptId: ChannelDeliveryAttemptId;
    readonly outboundMessageId: OutboundChannelMessageId;
    readonly outcome: TelegramProviderAttemptOutcome;
  }) => Effect.Effect<void, TelegramDeliveryPersistenceUnavailable>;
}

/** Durable authority seam around outbound Telegram provider calls. */
export class TelegramDeliveryStore extends Context.Tag(
  "@xpensego/domain/channel/TelegramDeliveryStore",
)<TelegramDeliveryStore, TelegramDeliveryStoreService>() {}

/** Explicit provider rejection that is safe to retry within the attempt limit. */
export class TelegramProviderTransientFailure extends Schema.TaggedError<TelegramProviderTransientFailure>()(
  "TelegramProviderTransientFailure",
  { errorCode: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)) },
) {
  /** Safe provider classification without response contents. */
  override get message(): string {
    return `Telegram explicitly rejected the request transiently: ${this.errorCode}`;
  }
}

/** Explicit provider rejection that must not be retried. */
export class TelegramProviderTerminalFailure extends Schema.TaggedError<TelegramProviderTerminalFailure>()(
  "TelegramProviderTerminalFailure",
  { errorCode: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)) },
) {
  /** Safe provider classification without response contents. */
  override get message(): string {
    return `Telegram explicitly rejected the request terminally: ${this.errorCode}`;
  }
}

/** Provider outcome that cannot safely be classified as accepted or rejected. */
export class TelegramProviderOutcomeUnknown extends Schema.TaggedError<TelegramProviderOutcomeUnknown>()(
  "TelegramProviderOutcomeUnknown",
  { errorCode: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)) },
) {
  /** Safe ambiguity description without response contents. */
  override get message(): string {
    return `Telegram request acceptance could not be determined: ${this.errorCode}`;
  }
}

/** Provider authority for rendering and sending one semantic Telegram reply. */
export interface TelegramBotApiService {
  /** Validate local provider configuration before a durable attempt is claimed. */
  readonly ensureAvailable: () => Effect.Effect<void, TelegramProviderTransientFailure>;

  readonly send: (input: {
    readonly externalConversationId: TelegramConversationId;
    readonly intent: TelegramReplyIntentV1;
  }) => Effect.Effect<
    { readonly providerMessageId: string },
    | TelegramProviderTransientFailure
    | TelegramProviderTerminalFailure
    | TelegramProviderOutcomeUnknown
  >;
}

/** Telegram Bot API provider seam. */
export class TelegramBotApi extends Context.Tag("@xpensego/domain/channel/TelegramBotApi")<
  TelegramBotApi,
  TelegramBotApiService
>() {}

/** Retry signal after an explicit transient provider rejection or an active lease. */
export class TelegramReplyDeliveryDeferred extends Schema.TaggedError<TelegramReplyDeliveryDeferred>()(
  "TelegramReplyDeliveryDeferred",
  { retryAfterSeconds: Schema.Int.pipe(Schema.positive()) },
) {
  /** Safe retry description. */
  override get message(): string {
    return `Telegram reply delivery is deferred for ${this.retryAfterSeconds} seconds`;
  }
}

/** Terminal, observable application outcome for one reply outbox delivery. */
export type DeliverTelegramReplyOutcome =
  | { readonly _tag: "ProviderAccepted" }
  | { readonly _tag: "Terminal" }
  | { readonly _tag: "OutcomeUnknown" }
  | { readonly _tag: "NotFound" };

/** Deliver one durable Telegram reply without blind retries after ambiguous provider outcomes. */
export const deliverTelegramReply = Effect.fn("Channel.deliverTelegramReply")(function* (input: {
  readonly outboxMessageId: OutboxMessageId;
}) {
  const store = yield* TelegramDeliveryStore;
  const provider = yield* TelegramBotApi;
  const availability = yield* provider.ensureAvailable().pipe(Effect.either);
  if (availability._tag === "Left") {
    return yield* new TelegramReplyDeliveryDeferred({ retryAfterSeconds: 60 });
  }
  const claim = yield* store.claim({
    outboxMessageId: input.outboxMessageId,
    policy: defaultTelegramDeliveryPolicy,
  });
  switch (claim._tag) {
    case "NotFound":
      return { _tag: "NotFound" } as const;
    case "Terminal":
      return { _tag: "Terminal" } as const;
    case "Deferred":
      return yield* new TelegramReplyDeliveryDeferred({
        retryAfterSeconds: claim.retryAfterSeconds,
      });
    case "Claimed": {
      const sent = yield* provider
        .send({
          externalConversationId: claim.externalConversationId,
          intent: claim.intent,
        })
        .pipe(Effect.either);
      if (sent._tag === "Right") {
        yield* store.completeAttempt({
          attemptId: claim.attemptId,
          outboundMessageId: claim.outboundMessageId,
          outcome: {
            _tag: "ProviderAccepted",
            providerMessageId: sent.right.providerMessageId,
          },
        });
        return { _tag: "ProviderAccepted" } as const;
      }
      const error = sent.left;
      if (error instanceof TelegramProviderTransientFailure) {
        yield* store.completeAttempt({
          attemptId: claim.attemptId,
          outboundMessageId: claim.outboundMessageId,
          outcome: { _tag: "TransientFailure", errorCode: error.errorCode },
        });
        return yield* new TelegramReplyDeliveryDeferred({ retryAfterSeconds: 30 });
      }
      if (error instanceof TelegramProviderTerminalFailure) {
        yield* store.completeAttempt({
          attemptId: claim.attemptId,
          outboundMessageId: claim.outboundMessageId,
          outcome: { _tag: "TerminalFailure", errorCode: error.errorCode },
        });
        return { _tag: "Terminal" } as const;
      }
      yield* store.completeAttempt({
        attemptId: claim.attemptId,
        outboundMessageId: claim.outboundMessageId,
        outcome: { _tag: "OutcomeUnknown", errorCode: error.errorCode },
      });
      return { _tag: "OutcomeUnknown" } as const;
    }
  }
});
