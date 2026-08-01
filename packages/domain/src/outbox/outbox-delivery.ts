import type { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import {
  OutboxMessageId,
  type OutboxMessageId as OutboxMessageIdType,
} from "@xpensego/contracts/platform/outbox-message-id";
import { Context, Effect, Schema } from "effect";

import { RuntimeTelemetry } from "../platform/runtime-telemetry.js";

/** Identifier for one time-bounded PostgreSQL publication claim. */
export const OutboxClaimId = Schema.UUID.pipe(Schema.brand("OutboxClaimId"));

/** A parsed PostgreSQL publication-claim identifier. */
export type OutboxClaimId = typeof OutboxClaimId.Type;

/** Positive number of rows a dispatcher may claim in one invocation. */
export const OutboxBatchLimit = Schema.Int.pipe(
  Schema.between(1, 100),
  Schema.brand("OutboxBatchLimit"),
);

/** A parsed dispatcher batch limit. */
export type OutboxBatchLimit = typeof OutboxBatchLimit.Type;

/** Positive number of seconds for which one publication claim remains owned. */
export const OutboxLeaseDurationSeconds = Schema.Int.pipe(
  Schema.between(1, 300),
  Schema.brand("OutboxLeaseDurationSeconds"),
);

/** A parsed publication-claim lease duration in seconds. */
export type OutboxLeaseDurationSeconds = typeof OutboxLeaseDurationSeconds.Type;

/** Positive, persisted publication-attempt counter. */
export const OutboxPublicationAttempt = Schema.Int.pipe(
  Schema.positive(),
  Schema.brand("OutboxPublicationAttempt"),
);

/** A parsed publication-attempt counter. */
export type OutboxPublicationAttempt = typeof OutboxPublicationAttempt.Type;

/** Bounded total publication attempts before operator recovery is required. */
export const OutboxPublicationMaximumAttempts = Schema.Int.pipe(
  Schema.between(1, 20),
  Schema.brand("OutboxPublicationMaximumAttempts"),
);

/** A parsed maximum publication-attempt count. */
export type OutboxPublicationMaximumAttempts = typeof OutboxPublicationMaximumAttempts.Type;

/** Non-negative delay before a failed publication can be claimed again. */
export const OutboxRetryDelaySeconds = Schema.Int.pipe(
  Schema.between(0, 3_600),
  Schema.brand("OutboxRetryDelaySeconds"),
);

/** A parsed retry delay in seconds. */
export type OutboxRetryDelaySeconds = typeof OutboxRetryDelaySeconds.Type;

/** Positive time allowed for a published message to acquire a consumer receipt. */
export const OutboxReceiptTimeoutSeconds = Schema.Int.pipe(
  Schema.between(60, 86_400),
  Schema.brand("OutboxReceiptTimeoutSeconds"),
);

/** A parsed consumer-receipt timeout in seconds. */
export type OutboxReceiptTimeoutSeconds = typeof OutboxReceiptTimeoutSeconds.Type;

/** One outbox message leased to a dispatcher invocation. */
export interface ClaimedOutboxPublication {
  readonly outboxMessageId: OutboxMessageIdType;
  readonly claimId: OutboxClaimId;
  readonly correlationId: CorrelationId;
  readonly attempt: OutboxPublicationAttempt;
}

/** Parameters for claiming pending outbox publications. */
export interface ClaimPendingOutboxInput {
  readonly limit: OutboxBatchLimit;
  readonly leaseDurationSeconds: OutboxLeaseDurationSeconds;
  readonly maximumAttempts: OutboxPublicationMaximumAttempts;
  readonly receiptTimeoutSeconds: OutboxReceiptTimeoutSeconds;
}

/** Parameters for recording successful Queue publication. */
export interface MarkOutboxPublishedInput {
  readonly outboxMessageId: OutboxMessageIdType;
  readonly claimId: OutboxClaimId;
}

/** Stable reason stored when Queue publication is deferred. */
export type OutboxPublicationFailureCode = "queue_outcome_unknown" | "queue_unavailable";

/** Durable transition chosen after one failed Queue publication attempt. */
export type OutboxPublicationFailureDisposition = "retry" | "terminal";

/** Parameters for releasing a failed publication claim for later recovery. */
export interface RecordOutboxPublicationFailureInput extends MarkOutboxPublishedInput {
  readonly errorCode: OutboxPublicationFailureCode;
  readonly retryDelaySeconds: OutboxRetryDelaySeconds;
  readonly disposition: OutboxPublicationFailureDisposition;
}

/** Parameters for explicitly returning one terminal publication to the dispatcher. */
export interface RecoverFailedOutboxPublicationInput {
  readonly outboxMessageId: OutboxMessageIdType;
}

/** Parameters for idempotently recording one Queue consumption. */
export interface RecordOutboxConsumptionInput {
  readonly outboxMessageId: OutboxMessageIdType;
}

/** First durable receipt for an outbox Queue message. */
export interface OutboxConsumptionProcessed {
  readonly _tag: "Processed";
}

/** A redelivery whose durable consumer receipt already exists. */
export interface OutboxConsumptionDuplicate {
  readonly _tag: "Duplicate";
}

/** An invalid Queue identifier that has no durable outbox authority. */
export interface OutboxConsumptionNotFound {
  readonly _tag: "NotFound";
}

/** Observable result of recording an outbox Queue consumption. */
export type OutboxConsumptionOutcome =
  OutboxConsumptionProcessed | OutboxConsumptionDuplicate | OutboxConsumptionNotFound;

/** Expected infrastructure failure while reading or changing outbox state. */
export class OutboxPersistenceUnavailable extends Schema.TaggedError<OutboxPersistenceUnavailable>()(
  "OutboxPersistenceUnavailable",
  {
    operation: Schema.Literal(
      "connectOutboxPersistence",
      "connectOutboxRecovery",
      "claimPendingOutbox",
      "markOutboxPublished",
      "recordOutboxPublicationFailure",
      "recordOutboxConsumption",
      "recoverFailedOutboxPublication",
    ),
    reason: Schema.Literal("database_unavailable"),
  },
) {
  /** Safe description that excludes SQL, credentials, and message contents. */
  override get message(): string {
    return "Outbox persistence is unavailable";
  }
}

/** Expected conflict when a stale dispatcher no longer owns a publication claim. */
export class OutboxPublicationStateConflict extends Schema.TaggedError<OutboxPublicationStateConflict>()(
  "OutboxPublicationStateConflict",
  {
    operation: Schema.Literal("markOutboxPublished", "recordOutboxPublicationFailure"),
    outboxMessageId: OutboxMessageId,
  },
) {
  /** Safe description that contains only the opaque outbox identifier. */
  override get message(): string {
    return `Outbox message ${this.outboxMessageId} is no longer owned by this dispatcher`;
  }
}

/** Expected transient failure from the Queue publication boundary. */
export class OutboxPublicationUnavailable extends Schema.TaggedError<OutboxPublicationUnavailable>()(
  "OutboxPublicationUnavailable",
  {
    operation: Schema.Literal("publishOutboxMessage"),
    outboxMessageId: OutboxMessageId,
    reason: Schema.Literal("queue_request_failed"),
  },
) {
  /** Safe description that excludes the Queue body and provider detail. */
  override get message(): string {
    return `Queue publication is unavailable for outbox message ${this.outboxMessageId}`;
  }
}

/** A timed-out Queue request that may have been accepted before the client lost certainty. */
export class OutboxPublicationOutcomeUnknown extends Schema.TaggedError<OutboxPublicationOutcomeUnknown>()(
  "OutboxPublicationOutcomeUnknown",
  {
    operation: Schema.Literal("publishOutboxMessage"),
    outboxMessageId: OutboxMessageId,
    reason: Schema.Literal("queue_timeout"),
  },
) {
  /** Safe description that excludes the Queue body and provider detail. */
  override get message(): string {
    return `Queue publication outcome is unknown for outbox message ${this.outboxMessageId}`;
  }
}

/** Application-owned durable outbox persistence capability. */
export interface OutboxPersistenceService {
  /** Claim an ordered batch without allowing concurrent dispatchers to claim the same rows. */
  readonly claimPending: (
    input: ClaimPendingOutboxInput,
  ) => Effect.Effect<ReadonlyArray<ClaimedOutboxPublication>, OutboxPersistenceUnavailable>;

  /** Mark a claimed message published after Queue acceptance. */
  readonly markPublished: (
    input: MarkOutboxPublishedInput,
  ) => Effect.Effect<void, OutboxPersistenceUnavailable | OutboxPublicationStateConflict>;

  /** Release a failed claim with a durable retry time and safe failure code. */
  readonly recordPublicationFailure: (
    input: RecordOutboxPublicationFailureInput,
  ) => Effect.Effect<void, OutboxPersistenceUnavailable | OutboxPublicationStateConflict>;

  /** Insert the durable idempotency receipt for one delivered Queue message. */
  readonly recordConsumption: (
    input: RecordOutboxConsumptionInput,
  ) => Effect.Effect<OutboxConsumptionOutcome, OutboxPersistenceUnavailable>;
}

/** Authority seam for transactional-outbox persistence and recovery. */
export class OutboxPersistence extends Context.Tag("@xpensego/domain/outbox/OutboxPersistence")<
  OutboxPersistence,
  OutboxPersistenceService
>() {}

/** Separately privileged operator capability for terminal publication recovery. */
export interface OutboxRecoveryService {
  /** Reset one terminal publication for a deliberate operator-controlled retry. */
  readonly recoverFailedPublication: (
    input: RecoverFailedOutboxPublicationInput,
  ) => Effect.Effect<boolean, OutboxPersistenceUnavailable>;
}

/** Administrative authority seam that is never provided to a Worker invocation. */
export class OutboxRecovery extends Context.Tag("@xpensego/domain/outbox/OutboxRecovery")<
  OutboxRecovery,
  OutboxRecoveryService
>() {}

/** Application-owned Queue publication capability. */
export interface OutboxPublicationService {
  /** Publish one content-minimized application message. */
  readonly publish: (input: {
    readonly outboxMessageId: OutboxMessageIdType;
    readonly correlationId: CorrelationId;
  }) => Effect.Effect<void, OutboxPublicationOutcomeUnknown | OutboxPublicationUnavailable>;
}

/** Authority seam for delivering durable outbox identifiers to the configured Queue. */
export class OutboxPublication extends Context.Tag("@xpensego/domain/outbox/OutboxPublication")<
  OutboxPublication,
  OutboxPublicationService
>() {}

/** Aggregate outcome from one bounded dispatcher invocation. */
export interface OutboxDispatchSummary {
  readonly claimed: number;
  readonly published: number;
  readonly deferred: number;
  readonly failed: number;
}

const dispatchBatchSize = Schema.decodeUnknownSync(OutboxBatchLimit)(10);
const publicationLeaseSeconds = Schema.decodeUnknownSync(OutboxLeaseDurationSeconds)(120);
const maximumPublicationAttempts = Schema.decodeUnknownSync(OutboxPublicationMaximumAttempts)(5);
const receiptTimeoutSeconds = Schema.decodeUnknownSync(OutboxReceiptTimeoutSeconds)(600);

function retryDelaySeconds(attempt: OutboxPublicationAttempt): OutboxRetryDelaySeconds {
  return Schema.decodeUnknownSync(OutboxRetryDelaySeconds)(
    Math.min(30 * 2 ** Math.min(Math.max(attempt - 1, 0), 6), 1_800),
  );
}

/** Claim and publish one bounded batch while preserving recoverability for every failure. */
export const dispatchPendingOutbox = Effect.fn("Outbox.dispatchPending")(function* () {
  const persistence = yield* OutboxPersistence;
  const publication = yield* OutboxPublication;
  const telemetry = yield* RuntimeTelemetry;
  const claimed = yield* persistence.claimPending({
    limit: dispatchBatchSize,
    leaseDurationSeconds: publicationLeaseSeconds,
    maximumAttempts: maximumPublicationAttempts,
    receiptTimeoutSeconds,
  });

  const outcomes = yield* Effect.forEach(
    claimed,
    (message) => {
      const publicationInput = {
        outboxMessageId: message.outboxMessageId,
        correlationId: message.correlationId,
      } as const;

      return publication.publish(publicationInput).pipe(
        Effect.matchEffect({
          onFailure: (error) => {
            const disposition =
              message.attempt >= maximumPublicationAttempts ? "terminal" : "retry";
            const outcomeUnknown = error._tag === "OutboxPublicationOutcomeUnknown";
            const telemetryEvent = outcomeUnknown
              ? ({
                  _tag: "OutboxPublicationOutcomeUnknown",
                  outboxMessageId: message.outboxMessageId,
                  correlationId: message.correlationId,
                  attempt: message.attempt,
                  outcome: "unknown",
                } as const)
              : disposition === "terminal"
                ? ({
                    _tag: "OutboxPublicationFailed",
                    outboxMessageId: message.outboxMessageId,
                    correlationId: message.correlationId,
                    attempt: message.attempt,
                    outcome: "failed",
                  } as const)
                : ({
                    _tag: "OutboxPublicationDeferred",
                    outboxMessageId: message.outboxMessageId,
                    correlationId: message.correlationId,
                    attempt: message.attempt,
                    outcome: "deferred",
                  } as const);
            return persistence
              .recordPublicationFailure({
                outboxMessageId: message.outboxMessageId,
                claimId: message.claimId,
                errorCode: outcomeUnknown ? "queue_outcome_unknown" : "queue_unavailable",
                retryDelaySeconds: outcomeUnknown
                  ? Schema.decodeUnknownSync(OutboxRetryDelaySeconds)(receiptTimeoutSeconds)
                  : retryDelaySeconds(message.attempt),
                disposition,
              })
              .pipe(
                Effect.zipRight(telemetry.emit(telemetryEvent)),
                Effect.as(disposition === "terminal" ? ("failed" as const) : ("deferred" as const)),
              );
          },
          onSuccess: () =>
            persistence
              .markPublished({
                outboxMessageId: message.outboxMessageId,
                claimId: message.claimId,
              })
              .pipe(
                Effect.zipRight(
                  telemetry.emit({
                    _tag: "OutboxPublicationSucceeded",
                    outboxMessageId: message.outboxMessageId,
                    correlationId: message.correlationId,
                    attempt: message.attempt,
                    outcome: "published",
                  }),
                ),
                Effect.as("published" as const),
              ),
        }),
      );
    },
    { concurrency: 5 },
  );

  const published = outcomes.filter((outcome) => outcome === "published").length;
  const failed = outcomes.filter((outcome) => outcome === "failed").length;

  return {
    claimed: claimed.length,
    published,
    deferred: outcomes.length - published - failed,
    failed,
  } satisfies OutboxDispatchSummary;
});

/** Return one terminal publication to the dispatcher through an explicit operator action. */
export const recoverFailedOutboxPublication = Effect.fn("Outbox.recoverFailedPublication")(
  function* (input: RecoverFailedOutboxPublicationInput) {
    const recovery = yield* OutboxRecovery;
    return yield* recovery.recoverFailedPublication(input);
  },
);

/** Record a duplicate-safe Queue consumer receipt and emit its safe outcome. */
export const recordOutboxConsumption = Effect.fn("Outbox.recordConsumption")(function* (input: {
  readonly outboxMessageId: OutboxMessageIdType;
  readonly correlationId: CorrelationId;
}) {
  const persistence = yield* OutboxPersistence;
  const telemetry = yield* RuntimeTelemetry;
  const outcome = yield* persistence.recordConsumption({
    outboxMessageId: input.outboxMessageId,
  });

  yield* telemetry.emit({
    _tag: "OutboxConsumptionRecorded",
    outboxMessageId: input.outboxMessageId,
    correlationId: input.correlationId,
    outcome:
      outcome._tag === "Processed"
        ? "processed"
        : outcome._tag === "Duplicate"
          ? "duplicate"
          : "not_found",
  });

  return outcome;
});
