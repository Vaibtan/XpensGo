import type { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { Context, Effect, Schema } from "effect";

import type { ExternalChannelEventId, InboundEventId, MessagingChannel } from "./inbound-event.js";
import { UserId } from "../identity/user-id.js";
import { LedgerId } from "../ledger/ledger-id.js";
import type { OutboxMessageId } from "../outbox/outbox-message-id.js";

const InboundEventIdempotencyKey = Schema.NonEmptyString.pipe(
  Schema.brand("InboundEventIdempotencyKey"),
);

type InboundEventIdempotencyKey = typeof InboundEventIdempotencyKey.Type;

/** Input accepted by the channel-ingress application operation. */
export interface AcceptInboundEventInput {
  /** Authenticated user who owns the target ledger. */
  readonly ownerUserId: UserId;

  /** Ledger to which the inbound event belongs. */
  readonly ledgerId: LedgerId;

  /** Messaging channel that delivered the event. */
  readonly channel: MessagingChannel;

  /** Stable event identifier assigned by the messaging provider. */
  readonly externalEventId: ExternalChannelEventId;

  /** Correlation identifier propagated from the ingress boundary. */
  readonly correlationId: CorrelationId;
}

/** First successful acceptance of a channel event. */
export interface InboundEventAccepted {
  readonly _tag: "Accepted";
  readonly inboundEventId: InboundEventId;
  readonly outboxMessageId: OutboxMessageId;
}

/** A redelivery that was already accepted through the same provider event key. */
export interface InboundEventDuplicate {
  readonly _tag: "Duplicate";
}

/** Observable result of accepting a channel event. */
export type AcceptInboundEventOutcome = InboundEventAccepted | InboundEventDuplicate;

/** Expected rejection when the authenticated user does not own the target ledger. */
export class InboundEventOwnershipMismatch extends Schema.TaggedError<InboundEventOwnershipMismatch>()(
  "InboundEventOwnershipMismatch",
  {
    operation: Schema.Literal("persistInboundEvent"),
    ownerUserId: UserId,
    ledgerId: LedgerId,
  },
) {
  /** Safe description that omits provider payloads and credentials. */
  override get message(): string {
    return "The target ledger is not owned by the authenticated user";
  }
}

/** Expected infrastructure failure while durably accepting an inbound event. */
export class InboundEventPersistenceUnavailable extends Schema.TaggedError<InboundEventPersistenceUnavailable>()(
  "InboundEventPersistenceUnavailable",
  {
    operation: Schema.Literal("connectInboundEventStore", "persistInboundEvent"),
    cause: Schema.Unknown,
  },
) {
  /** Safe description that leaves raw provider detail in the structured cause. */
  override get message(): string {
    return "Inbound event persistence is unavailable";
  }
}

/** Failures callers must translate at the channel boundary. */
export type AcceptInboundEventError =
  InboundEventOwnershipMismatch | InboundEventPersistenceUnavailable;

/** Application-owned persistence command after idempotency policy is applied. */
export interface PersistInboundEventInput extends AcceptInboundEventInput {
  /** Deterministic application idempotency key for the provider delivery. */
  readonly idempotencyKey: InboundEventIdempotencyKey;

  /** Versioned outbox contract emitted atomically with event acceptance. */
  readonly outboxKind: "channel.event.received.v1";
}

/** Persistence capability required by channel event acceptance. */
export interface InboundEventStoreService {
  /**
   * Atomically persist an inbound event and its transactional outbox message.
   *
   * @param input - Application-shaped persistence command.
   * @returns Whether this invocation accepted a new event or observed a duplicate.
   */
  readonly persist: (
    input: PersistInboundEventInput,
  ) => Effect.Effect<AcceptInboundEventOutcome, AcceptInboundEventError>;
}

/** Authority seam for durable inbound-channel acceptance. */
export class InboundEventStore extends Context.Tag("@xpensego/domain/channel/InboundEventStore")<
  InboundEventStore,
  InboundEventStoreService
>() {}

/**
 * Accept one authenticated provider event using deterministic application idempotency.
 *
 * @param input - Parsed messaging-channel event, ownership context, and correlation metadata.
 * @returns A typed accepted-or-duplicate outcome after atomic persistence.
 */
export const acceptInboundEvent = Effect.fn("Channel.acceptInboundEvent")(function* (
  input: AcceptInboundEventInput,
) {
  const store = yield* InboundEventStore;
  const idempotencyKey = InboundEventIdempotencyKey.make(
    `${input.channel}:${input.externalEventId}`,
  );

  return yield* store.persist({
    ...input,
    idempotencyKey,
    outboxKind: "channel.event.received.v1",
  });
});
