import type { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import type { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import { Context, Effect, Schema } from "effect";

import {
  defaultTelegramDeliveryPolicy,
  type TelegramMaximumDeliveryAttempts,
} from "./deliver-telegram-reply.js";
import { OutboundChannelMessageId } from "./outbound-channel-intent.js";
import { OutboxPublication } from "../outbox/outbox-delivery.js";

/** Stable idempotency key for one deliberate operator recovery request. */
export const TelegramDeliveryRecoveryId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  Schema.brand("TelegramDeliveryRecoveryId"),
);

/** Safe provider error code an operator must match before changing delivery state. */
export const TelegramDeliveryRecoveryExpectedErrorCode = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64),
  Schema.pattern(/^[a-z0-9_]+$/),
  Schema.brand("TelegramDeliveryRecoveryExpectedErrorCode"),
);

/** Reviewed reasons that may authorize one terminal Telegram delivery retry. */
export const TelegramDeliveryRecoveryReason = Schema.Literal(
  "recipient_state_corrected",
  "provider_configuration_corrected",
);

/** Parsed Telegram delivery recovery identifier. */
export type TelegramDeliveryRecoveryId = typeof TelegramDeliveryRecoveryId.Type;

/** Parsed expected provider error code. */
export type TelegramDeliveryRecoveryExpectedErrorCode =
  typeof TelegramDeliveryRecoveryExpectedErrorCode.Type;

/** Parsed operator recovery reason. */
export type TelegramDeliveryRecoveryReason = typeof TelegramDeliveryRecoveryReason.Type;

/** Reasons a durable Telegram delivery record cannot be recovered. */
export const TelegramDeliveryNotRecoverableReason = Schema.Literal(
  "not_found",
  "not_terminal_failure",
  "provider_accepted",
  "outcome_unknown",
  "error_code_mismatch",
  "attempt_limit_reached",
  "idempotency_conflict",
);

/** Parsed refusal reason for an operator recovery request. */
export type TelegramDeliveryNotRecoverableReason = typeof TelegramDeliveryNotRecoverableReason.Type;

/** Input for one idempotent operator-authorized recovery. */
export interface RecoverTelegramDeliveryInput {
  readonly recoveryId: TelegramDeliveryRecoveryId;
  readonly outboundMessageId: OutboundChannelMessageId;
  readonly expectedErrorCode: TelegramDeliveryRecoveryExpectedErrorCode;
  readonly reason: TelegramDeliveryRecoveryReason;
}

/** Durable preparation ready for Queue publication or already published there. */
export interface TelegramDeliveryRecoveryPrepared {
  readonly _tag: "Prepared";
  readonly publicationStatus: "prepared" | "published";
  readonly outboxMessageId: OutboxMessageId;
  readonly correlationId: CorrelationId;
}

/** Durable refusal that leaves the outbound message unchanged. */
export interface TelegramDeliveryRecoveryNotRecoverable {
  readonly _tag: "NotRecoverable";
  readonly reason: TelegramDeliveryNotRecoverableReason;
}

/** Result of preparing one recovery transaction. */
export type PrepareTelegramDeliveryRecoveryOutcome =
  TelegramDeliveryRecoveryPrepared | TelegramDeliveryRecoveryNotRecoverable;

/** Durable result of recording explicit Queue acceptance for a recovery. */
export type MarkTelegramDeliveryRecoveryPublishedOutcome =
  | { readonly _tag: "Published" }
  | { readonly _tag: "AlreadyPublished" }
  | { readonly _tag: "NotFound" };

/** Expected persistence failure while preparing or recording an operator recovery. */
export class TelegramDeliveryRecoveryPersistenceUnavailable extends Schema.TaggedError<TelegramDeliveryRecoveryPersistenceUnavailable>()(
  "TelegramDeliveryRecoveryPersistenceUnavailable",
  {
    operation: Schema.Literal(
      "connectTelegramDeliveryRecovery",
      "prepareTelegramDeliveryRecovery",
      "markTelegramDeliveryRecoveryPublished",
    ),
    reason: Schema.Literal("database_unavailable"),
  },
) {
  /** Safe description without credentials or provider contents. */
  override get message(): string {
    return "Telegram delivery recovery persistence is unavailable";
  }
}

/** Durable recovery preparation disappeared before Queue acceptance could be recorded. */
export class TelegramDeliveryRecoveryStateConflict extends Schema.TaggedError<TelegramDeliveryRecoveryStateConflict>()(
  "TelegramDeliveryRecoveryStateConflict",
  { recoveryId: TelegramDeliveryRecoveryId },
) {
  /** Safe description containing only the operator idempotency key. */
  override get message(): string {
    return `Telegram delivery recovery ${this.recoveryId} is no longer prepared`;
  }
}

/** Persistence authority for bounded, auditable Telegram delivery recovery. */
export interface TelegramDeliveryRecoveryStoreService {
  /** Prepare or resume one idempotent recovery while enforcing the provider-attempt ceiling. */
  readonly prepare: (
    input: RecoverTelegramDeliveryInput & {
      readonly maximumAttempts: TelegramMaximumDeliveryAttempts;
    },
  ) => Effect.Effect<
    PrepareTelegramDeliveryRecoveryOutcome,
    TelegramDeliveryRecoveryPersistenceUnavailable
  >;

  /** Record explicit Queue acceptance for an existing durable recovery. */
  readonly markPublished: (input: {
    readonly recoveryId: TelegramDeliveryRecoveryId;
  }) => Effect.Effect<
    MarkTelegramDeliveryRecoveryPublishedOutcome,
    TelegramDeliveryRecoveryPersistenceUnavailable
  >;
}

/** Separately composed authority seam for operator Telegram delivery recovery. */
export class TelegramDeliveryRecoveryStore extends Context.Tag(
  "@xpensego/domain/channel/TelegramDeliveryRecoveryStore",
)<TelegramDeliveryRecoveryStore, TelegramDeliveryRecoveryStoreService>() {}

/** Observable successful recovery publication. */
export interface TelegramDeliveryRecovered {
  readonly _tag: "Recovered";
  readonly publication: "published" | "already_published";
}

/** Observable result of one operator recovery request. */
export type RecoverTelegramDeliveryOutcome =
  TelegramDeliveryRecovered | TelegramDeliveryRecoveryNotRecoverable;

/**
 * Prepare one bounded Telegram retry and publish its existing outbox job.
 *
 * Repeating the same recovery identifier is safe. An uncertain Queue outcome leaves the durable
 * preparation unpublished so the operator may retry; duplicate Queue jobs still converge on the
 * provider-attempt claim before any external send.
 */
export const recoverTelegramDelivery = Effect.fn("Channel.recoverTelegramDelivery")(function* (
  input: RecoverTelegramDeliveryInput,
) {
  const store = yield* TelegramDeliveryRecoveryStore;
  const publication = yield* OutboxPublication;
  const prepared = yield* store.prepare({
    ...input,
    maximumAttempts: defaultTelegramDeliveryPolicy.maximumAttempts,
  });
  if (prepared._tag === "NotRecoverable") {
    return prepared;
  }
  if (prepared.publicationStatus === "published") {
    return { _tag: "Recovered", publication: "already_published" } as const;
  }

  yield* publication.publish({
    outboxMessageId: prepared.outboxMessageId,
    correlationId: prepared.correlationId,
  });
  const marked = yield* store.markPublished({ recoveryId: input.recoveryId });
  if (marked._tag === "NotFound") {
    return yield* new TelegramDeliveryRecoveryStateConflict({
      recoveryId: input.recoveryId,
    });
  }

  return { _tag: "Recovered", publication: "published" } as const;
});
