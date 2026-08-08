import type { ModelOperationId } from "@xpensego/contracts/model/model-operation-job";
import { Context, Effect, Schema } from "effect";

import type { UserId } from "../identity/user-id.js";
import {
  ModelAttemptId,
  ModelGateway,
  type ModelCompletionDisposition,
  type ModelGatewayError,
  type ModelGatewaySuccess,
  ModelInputDigest,
  type ModelOperationName,
  type ModelRetryPlan,
  classifyModelGatewayFailure,
} from "./model-gateway.js";
import { modelOperationOutputSchema } from "./model-operation-output.js";

/** Registered execution and cost ceiling for one enabled model operation. */
export interface ModelOperationProfile {
  readonly maximumCostMicroUsd: number;
  readonly maximumHttpDispatches: number;
  readonly maximumInputUtf8Bytes: number;
  readonly maximumPotentiallyBillableAttempts: number;
  readonly model: "gpt-5.4-nano-2026-03-17";
  readonly operationVersion: 1;
  readonly outputTokenLimit: number;
  readonly promptVersion: 1;
  readonly providerTimeoutMilliseconds: number;
  readonly retryPolicyVersion: 1;
  readonly schemaVersion: 1;
  readonly totalDeadlineMilliseconds: number;
  readonly transientRateLimitRetryLimit: 1;
}

/** Immutable registry for the three initially approved nano operations. */
export const modelOperationProfiles = {
  "query.slots.v1": {
    maximumCostMicroUsd: 480,
    maximumHttpDispatches: 2,
    maximumInputUtf8Bytes: 1_200,
    maximumPotentiallyBillableAttempts: 1,
    model: "gpt-5.4-nano-2026-03-17",
    operationVersion: 1,
    outputTokenLimit: 192,
    promptVersion: 1,
    providerTimeoutMilliseconds: 4_000,
    retryPolicyVersion: 1,
    schemaVersion: 1,
    totalDeadlineMilliseconds: 6_000,
    transientRateLimitRetryLimit: 1,
  },
  "transaction.extract.v1": {
    maximumCostMicroUsd: 620,
    maximumHttpDispatches: 2,
    maximumInputUtf8Bytes: 1_500,
    maximumPotentiallyBillableAttempts: 1,
    model: "gpt-5.4-nano-2026-03-17",
    operationVersion: 1,
    outputTokenLimit: 256,
    promptVersion: 1,
    providerTimeoutMilliseconds: 3_000,
    retryPolicyVersion: 1,
    schemaVersion: 1,
    totalDeadlineMilliseconds: 4_000,
    transientRateLimitRetryLimit: 1,
  },
  "transaction.extract_many.v1": {
    maximumCostMicroUsd: 3_100,
    maximumHttpDispatches: 2,
    maximumInputUtf8Bytes: 7_500,
    maximumPotentiallyBillableAttempts: 1,
    model: "gpt-5.4-nano-2026-03-17",
    operationVersion: 1,
    outputTokenLimit: 1_280,
    promptVersion: 1,
    providerTimeoutMilliseconds: 7_000,
    retryPolicyVersion: 1,
    schemaVersion: 1,
    totalDeadlineMilliseconds: 10_000,
    transientRateLimitRetryLimit: 1,
  },
} as const satisfies Record<ModelOperationName, ModelOperationProfile>;

/** Synchronous provider-spend controls selected by deployment environment. */
export const modelBudgetPolicies = {
  alpha: {
    environmentMonthlyCeilingMicroUsd: 5_000_000,
    userMonthlyCeilingMicroUsd: 250_000,
  },
  development_staging: {
    environmentMonthlyCeilingMicroUsd: 1_000_000,
    userMonthlyCeilingMicroUsd: 1_000_000,
  },
} as const;

/** Named deployment budget enforced before provider dispatch. */
export type ModelBudgetPolicyName = keyof typeof modelBudgetPolicies;

/** Immutable request persisted before a Queue wake-up may authorize dispatch. */
export interface PrepareModelOperationStoreInput {
  readonly canonicalInput: string;
  readonly dailyDispatchLimit: 20;
  readonly environmentBudgetKey: "development_staging" | "alpha";
  readonly environmentMonthlyCeilingMicroUsd: number;
  readonly explicitRestartLimit: 1;
  readonly inputDigest: ModelInputDigest;
  readonly operation: ModelOperationName;
  readonly operationId: ModelOperationId;
  readonly profile: ModelOperationProfile;
  readonly provider: "deterministic" | "openai";
  readonly reservedCostMicroUsd: number;
  readonly userId: UserId;
  readonly userMonthlyCeilingMicroUsd: number;
}

/** Durable creation outcome before any external dispatch. */
export type PrepareModelOperationOutcome =
  | { readonly _tag: "Prepared"; readonly operationId: ModelOperationId }
  | { readonly _tag: "Duplicate"; readonly operationId: ModelOperationId };

/** One operation identifier was already bound to a different canonical input. */
export class ModelOperationInputConflict extends Schema.TaggedError<ModelOperationInputConflict>()(
  "ModelOperationInputConflict",
  { operationId: Schema.UUID },
) {}

/** A synchronous application budget or abuse ceiling denied a new operation. */
export class ModelOperationBudgetExceeded extends Schema.TaggedError<ModelOperationBudgetExceeded>()(
  "ModelOperationBudgetExceeded",
  { scope: Schema.Literal("environment_month", "user_month", "user_day") },
) {}

/** The application-owned global model kill switch denied new work. */
export class ModelOperationKillSwitchEngaged extends Schema.TaggedError<ModelOperationKillSwitchEngaged>()(
  "ModelOperationKillSwitchEngaged",
  { budgetKey: Schema.Literal("development_staging", "alpha") },
) {}

/** Invalid or oversized caller input rejected before persistence or dispatch. */
export class InvalidModelOperationRequest extends Schema.TaggedError<InvalidModelOperationRequest>()(
  "InvalidModelOperationRequest",
  { reason: Schema.Literal("input_digest", "input_size") },
) {}

/** Durable recovery observed an unfinished dispatched attempt after its lease elapsed. */
export class ModelAttemptLeaseExpired extends Schema.TaggedError<ModelAttemptLeaseExpired>()(
  "ModelAttemptLeaseExpired",
  {
    attemptId: ModelAttemptId,
    operationId: Schema.UUID,
  },
) {}

/** The persisted operation deadline elapsed before another provider dispatch could be claimed. */
export class ModelRequestDeadlineExceededBeforeDispatch extends Schema.TaggedError<ModelRequestDeadlineExceededBeforeDispatch>()(
  "ModelRequestDeadlineExceededBeforeDispatch",
  { operationId: Schema.UUID },
) {}

/** An internal wake-up referenced an operation that does not exist. */
export class ModelOperationNotFound extends Schema.TaggedError<ModelOperationNotFound>()(
  "ModelOperationNotFound",
  { operationId: Schema.UUID },
) {}

/** An explicit restart was not valid for the immutable operation lineage. */
export class ModelOperationRestartDenied extends Schema.TaggedError<ModelOperationRestartDenied>()(
  "ModelOperationRestartDenied",
  { reason: Schema.Literal("source_not_outcome_unknown", "restart_limit_exhausted") },
) {}

/** A requested restart identifier was already bound outside the requested lineage. */
export class ModelOperationRestartConflict extends Schema.TaggedError<ModelOperationRestartConflict>()(
  "ModelOperationRestartConflict",
  { operationId: Schema.UUID },
) {}

/** The per-user provider-dispatch ceiling rejected work before an HTTP call. */
export class ModelDailyDispatchLimitExceeded extends Schema.TaggedError<ModelDailyDispatchLimitExceeded>()(
  "ModelDailyDispatchLimitExceeded",
  { limit: Schema.Int.pipe(Schema.positive()) },
) {}

/** Persisted operation policy contained no remaining HTTP-dispatch grant. */
export class ModelOperationDispatchLimitExceeded extends Schema.TaggedError<ModelOperationDispatchLimitExceeded>()(
  "ModelOperationDispatchLimitExceeded",
  { limit: Schema.Int.pipe(Schema.positive()) },
) {}

/** Structurally decoded provider output failed deterministic application validation. */
export class ModelOperationDomainValidationRejected extends Schema.TaggedError<ModelOperationDomainValidationRejected>()(
  "ModelOperationDomainValidationRejected",
  { reason: Schema.Literal("invalid_date") },
) {}

/** Safe persisted terminal summary for one durable model operation. */
export interface ModelOperationCompletion {
  readonly disposition: ModelCompletionDisposition;
  readonly observedFailure:
    | ModelGatewayError["_tag"]
    | "ModelAttemptLeaseExpired"
    | "ModelRequestDeadlineExceededBeforeDispatch"
    | "ModelDailyDispatchLimitExceeded"
    | "ModelOperationKillSwitchEngaged"
    | "ModelOperationDispatchLimitExceeded"
    | "ModelOperationDomainValidationRejected"
    | null;
  readonly retryPlan: ModelRetryPlan;
}

/** Provider-attempt authority returned by the durable store after an atomic claim. */
export interface ClaimedModelAttempt {
  readonly attemptId: ModelAttemptId;
  readonly attemptOrdinal: number;
  readonly canonicalInput: string;
  readonly inputDigest: ModelInputDigest;
  readonly model: string;
  readonly operation: ModelOperationName;
  readonly operationId: ModelOperationId;
  readonly outputTokenLimit: number;
  readonly promptVersion: number;
  readonly provider: "openai" | "deterministic";
  readonly providerTimeoutMilliseconds: number;
  readonly schemaVersion: number;
  readonly totalDeadlineMilliseconds: number;
  readonly transientRateLimitRetryAvailable: boolean;
}

/** Atomic claim outcome for a Queue wake-up or concurrent execution. */
export type ClaimModelOperationOutcome =
  | { readonly _tag: "Claimed"; readonly attempt: ClaimedModelAttempt }
  | { readonly _tag: "Completed"; readonly completion: ModelOperationCompletion }
  | { readonly _tag: "Rejected"; readonly completion: ModelOperationCompletion }
  | { readonly _tag: "Deferred"; readonly retryAfterMilliseconds: number };

/** Expected inability to read or mutate durable Model Operation state. */
export class ModelOperationPersistenceUnavailable extends Schema.TaggedError<ModelOperationPersistenceUnavailable>()(
  "ModelOperationPersistenceUnavailable",
  { operation: Schema.Literal("claim", "complete", "prepare", "restart") },
) {}

/** Completion input kept separate from the provider adapter's SDK response. */
export interface CompleteModelOperationInput<A> {
  readonly attemptId: ModelAttemptId;
  readonly completion: ModelOperationCompletion;
  readonly operationId: ModelOperationId;
  readonly result: ModelGatewaySuccess<A> | null;
}

/** Identity-scoped request for the single explicit restart grant. */
export interface RestartModelOperationStoreInput {
  readonly restartedOperationId: ModelOperationId;
  readonly sourceOperationId: ModelOperationId;
  readonly userId: UserId;
}

/** Durable result of creating or replaying one linked restart. */
export type RestartModelOperationOutcome =
  | { readonly _tag: "Restarted"; readonly operationId: ModelOperationId }
  | { readonly _tag: "Duplicate"; readonly operationId: ModelOperationId };

/** PostgreSQL authority for claims, leases, attempts, budgets, and terminal completion. */
export interface ModelOperationStoreService {
  readonly prepare: (
    input: PrepareModelOperationStoreInput,
  ) => Effect.Effect<
    PrepareModelOperationOutcome,
    | ModelOperationBudgetExceeded
    | ModelOperationInputConflict
    | ModelOperationKillSwitchEngaged
    | ModelOperationPersistenceUnavailable
  >;
  readonly claim: (
    operationId: ModelOperationId,
  ) => Effect.Effect<
    ClaimModelOperationOutcome,
    ModelOperationBudgetExceeded | ModelOperationNotFound | ModelOperationPersistenceUnavailable
  >;
  readonly complete: <A>(
    input: CompleteModelOperationInput<A>,
  ) => Effect.Effect<
    ModelOperationCompletion,
    ModelOperationNotFound | ModelOperationPersistenceUnavailable
  >;
  readonly restart: (
    input: RestartModelOperationStoreInput,
  ) => Effect.Effect<
    RestartModelOperationOutcome,
    | ModelOperationBudgetExceeded
    | ModelOperationKillSwitchEngaged
    | ModelOperationNotFound
    | ModelOperationPersistenceUnavailable
    | ModelOperationRestartConflict
    | ModelOperationRestartDenied
  >;
}

/** Durable Model Operation persistence seam. */
export class ModelOperationStore extends Context.Tag("@xpensego/domain/model/ModelOperationStore")<
  ModelOperationStore,
  ModelOperationStoreService
>() {}

function utf8ByteLength(value: string): number {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    length += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return length;
}

/** Persist one budget-reserved Model Operation using the immutable registry profile. */
export function prepareModelOperation(input: {
  readonly budgetPolicy?: ModelBudgetPolicyName;
  readonly canonicalInput: string;
  readonly inputDigest: string;
  readonly operation: ModelOperationName;
  readonly operationId: ModelOperationId;
  readonly provider: "deterministic" | "openai";
  readonly userId: UserId;
}): Effect.Effect<
  PrepareModelOperationOutcome,
  | InvalidModelOperationRequest
  | ModelOperationBudgetExceeded
  | ModelOperationInputConflict
  | ModelOperationKillSwitchEngaged
  | ModelOperationPersistenceUnavailable,
  ModelOperationStore
> {
  return Effect.gen(function* () {
    const profile = modelOperationProfiles[input.operation];
    if (
      input.canonicalInput.length < 1 ||
      utf8ByteLength(input.canonicalInput) > profile.maximumInputUtf8Bytes
    ) {
      return yield* new InvalidModelOperationRequest({ reason: "input_size" });
    }
    const digest = yield* Schema.decodeUnknown(ModelInputDigest)(input.inputDigest).pipe(
      Effect.mapError(() => new InvalidModelOperationRequest({ reason: "input_digest" })),
    );
    const store = yield* ModelOperationStore;
    const budgetPolicyName = input.budgetPolicy ?? "development_staging";
    const budgetPolicy = modelBudgetPolicies[budgetPolicyName];
    const usesProviderBudget = input.provider === "openai";

    return yield* store.prepare({
      canonicalInput: input.canonicalInput,
      dailyDispatchLimit: 20,
      environmentBudgetKey: budgetPolicyName,
      environmentMonthlyCeilingMicroUsd: budgetPolicy.environmentMonthlyCeilingMicroUsd,
      explicitRestartLimit: 1,
      inputDigest: digest,
      operation: input.operation,
      operationId: input.operationId,
      profile,
      provider: input.provider,
      reservedCostMicroUsd: usesProviderBudget ? profile.maximumCostMicroUsd : 0,
      userId: input.userId,
      userMonthlyCeilingMicroUsd: usesProviderBudget ? budgetPolicy.userMonthlyCeilingMicroUsd : 0,
    });
  });
}

/** Consume the lineage-wide explicit restart grant without mutating the unknown source attempt. */
export function restartModelOperation(
  input: RestartModelOperationStoreInput,
): Effect.Effect<
  RestartModelOperationOutcome,
  | ModelOperationBudgetExceeded
  | ModelOperationKillSwitchEngaged
  | ModelOperationNotFound
  | ModelOperationPersistenceUnavailable
  | ModelOperationRestartConflict
  | ModelOperationRestartDenied,
  ModelOperationStore
> {
  return ModelOperationStore.pipe(Effect.flatMap((store) => store.restart(input)));
}

function isValidIsoCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function containsInvalidExtractedDate(output: unknown): boolean {
  if (typeof output !== "object" || output === null) {
    return false;
  }
  const candidate = output as {
    readonly _tag?: unknown;
    readonly occurredOn?: unknown;
    readonly suggestions?: unknown;
    readonly outcome?: unknown;
  };
  if (candidate._tag === "Extracted" && typeof candidate.occurredOn === "string") {
    return !isValidIsoCalendarDate(candidate.occurredOn);
  }
  return (
    containsInvalidExtractedDate(candidate.outcome) ||
    (Array.isArray(candidate.suggestions) &&
      candidate.suggestions.some((suggestion) => containsInvalidExtractedDate(suggestion)))
  );
}

/** Caller-visible execution outcome for one Queue wake-up. */
export type ExecutePreparedModelOperationOutcome<A> =
  | { readonly _tag: "Succeeded"; readonly output: A }
  | { readonly _tag: "Failed"; readonly completion: ModelOperationCompletion }
  | { readonly _tag: "RetryScheduled"; readonly retryAfterMilliseconds: number }
  | { readonly _tag: "AlreadyCompleted"; readonly completion: ModelOperationCompletion }
  | { readonly _tag: "Deferred"; readonly retryAfterMilliseconds: number };

/** Execute at most one provider attempt authorized by durable state. */
export function executePreparedModelOperation<A = unknown, I = unknown>(input: {
  readonly operationId: ModelOperationId;
  readonly outputSchema?: Schema.Schema<A, I, never>;
}): Effect.Effect<
  ExecutePreparedModelOperationOutcome<A>,
  ModelOperationBudgetExceeded | ModelOperationNotFound | ModelOperationPersistenceUnavailable,
  ModelGateway | ModelOperationStore
> {
  return Effect.gen(function* () {
    const store = yield* ModelOperationStore;
    const gateway = yield* ModelGateway;
    const claim = yield* store.claim(input.operationId);

    if (claim._tag === "Completed") {
      return { _tag: "AlreadyCompleted", completion: claim.completion } as const;
    }
    if (claim._tag === "Rejected") {
      return { _tag: "Failed", completion: claim.completion } as const;
    }
    if (claim._tag === "Deferred") {
      return {
        _tag: "Deferred",
        retryAfterMilliseconds: claim.retryAfterMilliseconds,
      } as const;
    }

    const outputSchema = input.outputSchema ?? modelOperationOutputSchema(claim.attempt.operation);
    const result = yield* gateway.execute({ ...claim.attempt, outputSchema }).pipe(Effect.either);
    if (result._tag === "Right") {
      if (containsInvalidExtractedDate(result.right.output)) {
        const completion = yield* store.complete({
          attemptId: claim.attempt.attemptId,
          completion: {
            disposition: "invalid_output",
            observedFailure: "ModelOperationDomainValidationRejected",
            retryPlan: { _tag: "None" },
          },
          operationId: input.operationId,
          result: result.right,
        });
        return { _tag: "Failed", completion } as const;
      }
      const completion: ModelOperationCompletion = {
        disposition: "succeeded",
        observedFailure: null,
        retryPlan: { _tag: "None" },
      };
      yield* store.complete({
        attemptId: claim.attempt.attemptId,
        completion,
        operationId: input.operationId,
        result: result.right,
      });
      return { _tag: "Succeeded", output: result.right.output } as const;
    }

    const classification = classifyModelGatewayFailure(result.left, {
      transientRateLimitRetryAvailable: claim.attempt.transientRateLimitRetryAvailable,
    });
    const completion = yield* store.complete({
      attemptId: claim.attempt.attemptId,
      completion: classification,
      operationId: input.operationId,
      result: null,
    });

    return completion.retryPlan._tag === "ScheduleTransientRateLimit"
      ? ({
          _tag: "RetryScheduled",
          retryAfterMilliseconds: completion.retryPlan.delayMilliseconds,
        } as const)
      : ({ _tag: "Failed", completion } as const);
  });
}
