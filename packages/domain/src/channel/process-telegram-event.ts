import type { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import type { OutboxMessageId as OutboxMessageIdType } from "@xpensego/contracts/platform/outbox-message-id";
import { Context, Effect, Schema } from "effect";

import type { InboundEventId } from "./inbound-event.js";
import {
  OutboundChannelMessageId,
  type TelegramReplyContent,
  type TelegramReplyIntentV1,
} from "./outbound-channel-intent.js";
import type { PersistedTelegramEventV1, TelegramMessageText } from "./telegram-event.js";
import type { ChannelActorContext } from "../identity/actor-context.js";
import type { UserId } from "../identity/user-id.js";
import {
  ChannelIdentityNotFound,
  ChannelLinkChallengeAlreadyConsumed,
  ChannelLinkChallengeExpired,
  ChannelLinkChallengeNotFound,
  IdentityPersistenceUnavailable,
  TelegramIdentityAlreadyLinked,
  TelegramIdentityDoesNotMatchChallenge,
  consumeTelegramLinkChallengeDigest,
  consumeTelegramUnlinkChallengeDigest,
  resolveTelegramActor,
} from "../identity/identity.js";

/** Identifier for one leased inbound-event processing claim. */
export const TelegramProcessingClaimId = Schema.UUID.pipe(
  Schema.brand("TelegramProcessingClaimId"),
);

/** A parsed Telegram processing claim identifier. */
export type TelegramProcessingClaimId = typeof TelegramProcessingClaimId.Type;

/** Positive per-identity events permitted in one minute. */
export const TelegramPerIdentityRateLimit = Schema.Int.pipe(
  Schema.between(1, 1_000),
  Schema.brand("TelegramPerIdentityRateLimit"),
);

/** Positive system-wide events permitted in one minute. */
export const TelegramSystemRateLimit = Schema.Int.pipe(
  Schema.between(1, 100_000),
  Schema.brand("TelegramSystemRateLimit"),
);

/** Seconds for which one Queue consumer owns an inbound processing claim. */
export const TelegramProcessingLeaseSeconds = Schema.Int.pipe(
  Schema.between(10, 300),
  Schema.brand("TelegramProcessingLeaseSeconds"),
);

/** Parsed per-identity per-minute rate limit. */
export type TelegramPerIdentityRateLimit = typeof TelegramPerIdentityRateLimit.Type;

/** Parsed system-wide per-minute rate limit. */
export type TelegramSystemRateLimit = typeof TelegramSystemRateLimit.Type;

/** Parsed processing lease duration. */
export type TelegramProcessingLeaseSeconds = typeof TelegramProcessingLeaseSeconds.Type;

/** Abuse and claim policy applied before identity resolution. */
export interface TelegramProcessingPolicy {
  readonly perIdentityPerMinute: TelegramPerIdentityRateLimit;
  readonly systemPerMinute: TelegramSystemRateLimit;
  readonly leaseSeconds: TelegramProcessingLeaseSeconds;
}

/** Default bounded policy for development and the small alpha. */
export const defaultTelegramProcessingPolicy: TelegramProcessingPolicy = {
  perIdentityPerMinute: TelegramPerIdentityRateLimit.make(30),
  systemPerMinute: TelegramSystemRateLimit.make(300),
  leaseSeconds: TelegramProcessingLeaseSeconds.make(60),
};

/** Parameters for claiming one durable Telegram event from an outbox delivery. */
export interface ClaimTelegramEventInput {
  readonly outboxMessageId: OutboxMessageIdType;
  readonly policy: TelegramProcessingPolicy;
}

/** One inbound event leased to this Queue delivery. */
export interface TelegramEventClaimed {
  readonly _tag: "Claimed";
  readonly claimId: TelegramProcessingClaimId;
  readonly inboundEventId: InboundEventId;
  readonly event: PersistedTelegramEventV1;
}

/** Observable claim result before application processing. */
export type ClaimTelegramEventOutcome =
  | TelegramEventClaimed
  | { readonly _tag: "Duplicate" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "RateLimited" }
  | { readonly _tag: "Deferred"; readonly retryAfterSeconds: number };

/** Reply completion that also persists a linked, normalized text command. */
export interface LinkedTextAcceptedCompletion {
  readonly _tag: "LinkedTextAccepted";
  readonly actor: ChannelActorContext;
  readonly text: TelegramMessageText;
  readonly intent: TelegramReplyIntentV1;
}

/** Reply completion scoped by an authority resolved before the state change. */
export interface ScopedTelegramReplyCompletion {
  readonly _tag: "ScopedReply";
  readonly actor: ChannelActorContext;
  readonly intent: TelegramReplyIntentV1;
}

/** Safe system reply for an event that could not establish User authority. */
export interface UnscopedTelegramReplyCompletion {
  readonly _tag: "UnscopedReply";
  readonly intent: TelegramReplyIntentV1;
}

/** Terminal application result persisted for one claimed Telegram event. */
export type TelegramEventCompletion =
  LinkedTextAcceptedCompletion | ScopedTelegramReplyCompletion | UnscopedTelegramReplyCompletion;

/** Parameters for atomically completing event processing and creating a reply outbox. */
export interface CompleteTelegramEventInput {
  readonly claimId: TelegramProcessingClaimId;
  readonly inboundEventId: InboundEventId;
  readonly correlationId: CorrelationId;
  readonly completion: TelegramEventCompletion;
}

/** Parameters for releasing an event after a transient application dependency failure. */
export interface ReleaseTelegramEventInput {
  readonly claimId: TelegramProcessingClaimId;
  readonly inboundEventId: InboundEventId;
}

/** Parameters for enforcing a linked User's persisted minute window. */
export interface EnforceTelegramUserLimitInput {
  readonly claimId: TelegramProcessingClaimId;
  readonly inboundEventId: InboundEventId;
  readonly userId: UserId;
  readonly maximumEventsPerMinute: TelegramPerIdentityRateLimit;
}

/** Persisted User-level abuse decision for one claimed event. */
export type EnforceTelegramUserLimitOutcome =
  { readonly _tag: "Allowed" } | { readonly _tag: "RateLimited" };

/** Successful atomic event completion. */
export interface TelegramEventCompleted {
  readonly _tag: "Completed";
  readonly outboundMessageId: OutboundChannelMessageId;
}

/** Expected persistence failure while processing a Telegram event. */
export class TelegramEventProcessingPersistenceUnavailable extends Schema.TaggedError<TelegramEventProcessingPersistenceUnavailable>()(
  "TelegramEventProcessingPersistenceUnavailable",
  {
    operation: Schema.Literal(
      "claimTelegramEvent",
      "completeTelegramEvent",
      "connectTelegramEventProcessing",
      "enforceTelegramUserLimit",
      "releaseTelegramEvent",
    ),
    reason: Schema.Literal("database_unavailable"),
  },
) {
  /** Safe infrastructure description. */
  override get message(): string {
    return "Telegram event processing persistence is unavailable";
  }
}

/** Expected retry signal while another Queue delivery owns the event claim. */
export class TelegramEventProcessingDeferred extends Schema.TaggedError<TelegramEventProcessingDeferred>()(
  "TelegramEventProcessingDeferred",
  { retryAfterSeconds: Schema.Int.pipe(Schema.positive()) },
) {
  /** Safe retry description. */
  override get message(): string {
    return "Telegram event processing is already in progress";
  }
}

/** Expected retry signal when Identity persistence is temporarily unavailable. */
export class TelegramIdentityResolutionUnavailable extends Schema.TaggedError<TelegramIdentityResolutionUnavailable>()(
  "TelegramIdentityResolutionUnavailable",
  {},
) {
  /** Safe dependency description. */
  override get message(): string {
    return "Telegram identity resolution is temporarily unavailable";
  }
}

/** Persistence authority for claim, abuse, normalized-command, and reply creation state. */
export interface TelegramEventProcessingStoreService {
  /** Claim one event and enforce persisted abuse limits exactly once. */
  readonly claim: (
    input: ClaimTelegramEventInput,
  ) => Effect.Effect<ClaimTelegramEventOutcome, TelegramEventProcessingPersistenceUnavailable>;

  /** Atomically persist terminal processing, normalized command, reply intent, and outbox. */
  readonly complete: (
    input: CompleteTelegramEventInput,
  ) => Effect.Effect<TelegramEventCompleted, TelegramEventProcessingPersistenceUnavailable>;

  /** Enforce a linked User window once, after server-side identity resolution. */
  readonly enforceUserLimit: (
    input: EnforceTelegramUserLimitInput,
  ) => Effect.Effect<
    EnforceTelegramUserLimitOutcome,
    TelegramEventProcessingPersistenceUnavailable
  >;

  /** Release a claim after a retryable dependency failure. */
  readonly release: (
    input: ReleaseTelegramEventInput,
  ) => Effect.Effect<void, TelegramEventProcessingPersistenceUnavailable>;
}

/** Authority seam for durable asynchronous Telegram event processing. */
export class TelegramEventProcessingStore extends Context.Tag(
  "@xpensego/domain/channel/TelegramEventProcessingStore",
)<TelegramEventProcessingStore, TelegramEventProcessingStoreService>() {}

/** Observable terminal result of one Queue-delivered Telegram event. */
export type ProcessTelegramEventOutcome =
  | { readonly _tag: "Processed"; readonly outboundMessageId: OutboundChannelMessageId }
  | { readonly _tag: "Duplicate" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Suppressed"; readonly reason: "rate_limited" };

function intent(
  content: TelegramReplyContent,
  options: { readonly action: "none" | "workspace"; readonly purpose?: "reply" | "system" },
): TelegramReplyIntentV1 {
  return {
    version: 1,
    channel: "telegram",
    purpose: options.purpose ?? "system",
    privacy: "private",
    content,
    actions: options.action === "workspace" ? [{ _tag: "OpenWeb", path: "/workspace" }] : [],
  };
}

type TelegramChallengeRejectionError =
  | ChannelIdentityNotFound
  | ChannelLinkChallengeAlreadyConsumed
  | ChannelLinkChallengeExpired
  | ChannelLinkChallengeNotFound
  | TelegramIdentityAlreadyLinked
  | TelegramIdentityDoesNotMatchChallenge;

const challengeRejectionReason = {
  ChannelIdentityNotFound: "identity_mismatch",
  ChannelLinkChallengeAlreadyConsumed: "already_used",
  ChannelLinkChallengeExpired: "expired",
  ChannelLinkChallengeNotFound: "not_found",
  TelegramIdentityAlreadyLinked: "already_linked",
  TelegramIdentityDoesNotMatchChallenge: "identity_mismatch",
} as const satisfies Record<
  TelegramChallengeRejectionError["_tag"],
  Extract<TelegramReplyContent, { readonly _tag: "ChallengeRejected" }>["reason"]
>;

function rejectedChallenge(
  purpose: "link" | "unlink",
  error: TelegramChallengeRejectionError,
): TelegramReplyContent {
  return {
    _tag: "ChallengeRejected",
    purpose,
    reason: challengeRejectionReason[error._tag],
  };
}

/** Process one Queue-delivered Telegram event through trusted Identity and durable reply seams. */
export const processTelegramEvent = Effect.fn("Channel.processTelegramEvent")(function* (input: {
  readonly outboxMessageId: OutboxMessageIdType;
  readonly correlationId: CorrelationId;
}) {
  const store = yield* TelegramEventProcessingStore;
  const claim = yield* store.claim({
    outboxMessageId: input.outboxMessageId,
    policy: defaultTelegramProcessingPolicy,
  });
  switch (claim._tag) {
    case "Duplicate":
      return { _tag: "Duplicate" } as const;
    case "NotFound":
      return { _tag: "NotFound" } as const;
    case "RateLimited":
      return { _tag: "Suppressed", reason: "rate_limited" } as const;
    case "Deferred":
      return yield* new TelegramEventProcessingDeferred({
        retryAfterSeconds: claim.retryAfterSeconds,
      });
    case "Claimed": {
      const complete = (completion: TelegramEventCompletion) =>
        store.complete({
          claimId: claim.claimId,
          inboundEventId: claim.inboundEventId,
          correlationId: input.correlationId,
          completion,
        });
      const releaseIdentityFailure = () =>
        store
          .release({ claimId: claim.claimId, inboundEventId: claim.inboundEventId })
          .pipe(Effect.zipRight(new TelegramIdentityResolutionUnavailable()));
      const enforceUserLimit = (actor: ChannelActorContext) =>
        store.enforceUserLimit({
          claimId: claim.claimId,
          inboundEventId: claim.inboundEventId,
          userId: actor.userId,
          maximumEventsPerMinute: defaultTelegramProcessingPolicy.perIdentityPerMinute,
        });

      switch (claim.event.content._tag) {
        case "InvalidCommand": {
          const completed = yield* complete({
            _tag: "UnscopedReply",
            intent: intent(
              {
                _tag: "ChallengeRejected",
                purpose: claim.event.content.command,
                reason: "invalid_command",
              },
              { action: "workspace" },
            ),
          });
          return { _tag: "Processed", outboundMessageId: completed.outboundMessageId } as const;
        }
        case "Text": {
          const resolved = yield* resolveTelegramActor({
            externalAccountId: claim.event.externalAccountId,
            correlationId: input.correlationId,
          }).pipe(Effect.either);
          if (resolved._tag === "Left") {
            if (resolved.left instanceof IdentityPersistenceUnavailable) {
              return yield* releaseIdentityFailure();
            }
            const completed = yield* complete({
              _tag: "UnscopedReply",
              intent: intent({ _tag: "LinkRequired" }, { action: "workspace" }),
            });
            return { _tag: "Processed", outboundMessageId: completed.outboundMessageId } as const;
          }
          const userLimit = yield* enforceUserLimit(resolved.right);
          if (userLimit._tag === "RateLimited") {
            return { _tag: "Suppressed", reason: "rate_limited" } as const;
          }
          const completed = yield* complete({
            _tag: "LinkedTextAccepted",
            actor: resolved.right,
            text: claim.event.content.text,
            intent: intent(
              { _tag: "CaptureUnavailable" },
              { action: "workspace", purpose: "reply" },
            ),
          });
          return { _tag: "Processed", outboundMessageId: completed.outboundMessageId } as const;
        }
        case "LinkCommand": {
          const linked = yield* consumeTelegramLinkChallengeDigest({
            tokenDigest: claim.event.content.challengeDigest,
            externalAccountId: claim.event.externalAccountId,
            correlationId: input.correlationId,
          }).pipe(Effect.either);
          if (linked._tag === "Left") {
            if (linked.left instanceof IdentityPersistenceUnavailable) {
              return yield* releaseIdentityFailure();
            }
            if (linked.left instanceof ChannelLinkChallengeAlreadyConsumed) {
              const replayActor = yield* resolveTelegramActor({
                externalAccountId: claim.event.externalAccountId,
                correlationId: input.correlationId,
              }).pipe(Effect.either);
              if (replayActor._tag === "Right") {
                const userLimit = yield* enforceUserLimit(replayActor.right);
                if (userLimit._tag === "RateLimited") {
                  return { _tag: "Suppressed", reason: "rate_limited" } as const;
                }
                const replayed = yield* complete({
                  _tag: "ScopedReply",
                  actor: replayActor.right,
                  intent: intent({ _tag: "LinkSucceeded" }, { action: "workspace" }),
                });
                return {
                  _tag: "Processed",
                  outboundMessageId: replayed.outboundMessageId,
                } as const;
              }
              if (replayActor.left instanceof IdentityPersistenceUnavailable) {
                return yield* releaseIdentityFailure();
              }
            }
            const completed = yield* complete({
              _tag: "UnscopedReply",
              intent: intent(rejectedChallenge("link", linked.left), { action: "workspace" }),
            });
            return { _tag: "Processed", outboundMessageId: completed.outboundMessageId } as const;
          }
          const userLimit = yield* enforceUserLimit(linked.right.actor);
          if (userLimit._tag === "RateLimited") {
            return { _tag: "Suppressed", reason: "rate_limited" } as const;
          }
          const completed = yield* complete({
            _tag: "ScopedReply",
            actor: linked.right.actor,
            intent: intent({ _tag: "LinkSucceeded" }, { action: "workspace" }),
          });
          return { _tag: "Processed", outboundMessageId: completed.outboundMessageId } as const;
        }
        case "UnlinkCommand": {
          const priorActor = yield* resolveTelegramActor({
            externalAccountId: claim.event.externalAccountId,
            correlationId: input.correlationId,
          }).pipe(Effect.either);
          if (
            priorActor._tag === "Left" &&
            priorActor.left instanceof IdentityPersistenceUnavailable
          ) {
            return yield* releaseIdentityFailure();
          }
          if (priorActor._tag === "Right") {
            const userLimit = yield* enforceUserLimit(priorActor.right);
            if (userLimit._tag === "RateLimited") {
              return { _tag: "Suppressed", reason: "rate_limited" } as const;
            }
          }
          const unlinked = yield* consumeTelegramUnlinkChallengeDigest({
            tokenDigest: claim.event.content.challengeDigest,
            externalAccountId: claim.event.externalAccountId,
            correlationId: input.correlationId,
          }).pipe(Effect.either);
          if (unlinked._tag === "Left") {
            if (unlinked.left instanceof IdentityPersistenceUnavailable) {
              return yield* releaseIdentityFailure();
            }
            if (
              unlinked.left instanceof ChannelLinkChallengeAlreadyConsumed &&
              priorActor._tag === "Left"
            ) {
              const replayed = yield* complete({
                _tag: "UnscopedReply",
                intent: intent({ _tag: "UnlinkSucceeded" }, { action: "workspace" }),
              });
              return {
                _tag: "Processed",
                outboundMessageId: replayed.outboundMessageId,
              } as const;
            }
            const completed = yield* complete({
              _tag: "UnscopedReply",
              intent: intent(rejectedChallenge("unlink", unlinked.left), {
                action: "workspace",
              }),
            });
            return { _tag: "Processed", outboundMessageId: completed.outboundMessageId } as const;
          }
          const completion: TelegramEventCompletion =
            priorActor._tag === "Right"
              ? {
                  _tag: "ScopedReply",
                  actor: priorActor.right,
                  intent: intent({ _tag: "UnlinkSucceeded" }, { action: "workspace" }),
                }
              : {
                  _tag: "UnscopedReply",
                  intent: intent({ _tag: "UnlinkSucceeded" }, { action: "workspace" }),
                };
          const completed = yield* complete(completion);
          return { _tag: "Processed", outboundMessageId: completed.outboundMessageId } as const;
        }
      }
    }
  }
});
