import type { ModelOperationId } from "@xpensego/contracts/model/model-operation-job";
import { Context, type Effect, JSONSchema, Schema } from "effect";

/** Stable identifier for one provider HTTP dispatch attempt. */
export const ModelAttemptId = Schema.UUID.pipe(Schema.brand("ModelAttemptId"));

/** A parsed provider-attempt identifier. */
export type ModelAttemptId = typeof ModelAttemptId.Type;

/** SHA-256 digest of the canonical model input. */
export const ModelInputDigest = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{64}$/),
  Schema.brand("ModelInputDigest"),
);

/** A parsed canonical-input digest. */
export type ModelInputDigest = typeof ModelInputDigest.Type;

/** Initially enabled, registry-owned model operations. */
export const ModelOperationName = Schema.Literal(
  "transaction.extract.v1",
  "transaction.extract_many.v1",
  "query.slots.v1",
);

/** An enabled model-operation name. */
export type ModelOperationName = typeof ModelOperationName.Type;

const ModelProvider = Schema.Literal("openai", "deterministic");
const ModelSnapshot = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128));
const AttemptOrdinal = Schema.Int.pipe(Schema.positive());
const BoundedProviderStatus = Schema.Int.pipe(Schema.between(400, 599));
const FailureContext = {
  attemptOrdinal: AttemptOrdinal,
  model: ModelSnapshot,
  operation: ModelOperationName,
  provider: ModelProvider,
} as const;

/** Provider schema could not be generated from the registered Effect Schema. */
export class ModelSchemaUnsupported extends Schema.TaggedError<ModelSchemaUnsupported>()(
  "ModelSchemaUnsupported",
  { ...FailureContext, schemaVersion: Schema.Int.pipe(Schema.positive()) },
) {}

/** Provider explicitly rejected a dispatch because of a transient or non-retryable quota limit. */
export class ModelProviderRateLimited extends Schema.TaggedError<ModelProviderRateLimited>()(
  "ModelProviderRateLimited",
  {
    ...FailureContext,
    classification: Schema.Literal("transient", "quota"),
    retryAfterMilliseconds: Schema.Int.pipe(Schema.between(0, 60_000)),
  },
) {}

/** Provider explicitly rejected the dispatch for billing, quota, or required-action reasons. */
export class ModelProviderQuotaDenied extends Schema.TaggedError<ModelProviderQuotaDenied>()(
  "ModelProviderQuotaDenied",
  FailureContext,
) {}

/** The application deadline elapsed after dispatch began. */
export class ModelRequestDeadlineExceeded extends Schema.TaggedError<ModelRequestDeadlineExceeded>()(
  "ModelRequestDeadlineExceeded",
  { ...FailureContext, timeoutMilliseconds: Schema.Int.pipe(Schema.positive()) },
) {}

/** The connection was lost after dispatch began and provider acceptance is unknown. */
export class ModelProviderConnectionLost extends Schema.TaggedError<ModelProviderConnectionLost>()(
  "ModelProviderConnectionLost",
  FailureContext,
) {}

/** The provider returned no response body after dispatch. */
export class ModelProviderEmptyResponse extends Schema.TaggedError<ModelProviderEmptyResponse>()(
  "ModelProviderEmptyResponse",
  FailureContext,
) {}

/** The provider response could not be decoded as a supported response envelope. */
export class ModelProviderMalformedResponse extends Schema.TaggedError<ModelProviderMalformedResponse>()(
  "ModelProviderMalformedResponse",
  FailureContext,
) {}

/** The provider returned a server error after dispatch. */
export class ModelProviderHttp5xx extends Schema.TaggedError<ModelProviderHttp5xx>()(
  "ModelProviderHttp5xx",
  { ...FailureContext, status: BoundedProviderStatus },
) {}

/** The provider explicitly rejected an invalid or unauthorized request before model work. */
export class ModelProviderRequestRejected extends Schema.TaggedError<ModelProviderRequestRejected>()(
  "ModelProviderRequestRejected",
  { ...FailureContext, status: BoundedProviderStatus },
) {}

/** The model explicitly refused the requested structured extraction. */
export class ModelProviderRefusal extends Schema.TaggedError<ModelProviderRefusal>()(
  "ModelProviderRefusal",
  FailureContext,
) {}

/** The response ended at a token or provider limit before a complete object was produced. */
export class ModelProviderTruncated extends Schema.TaggedError<ModelProviderTruncated>()(
  "ModelProviderTruncated",
  FailureContext,
) {}

/** Structured output failed provider parsing or the authoritative Effect Schema decode. */
export class ModelStructuredOutputDecodingFailed extends Schema.TaggedError<ModelStructuredOutputDecodingFailed>()(
  "ModelStructuredOutputDecodingFailed",
  FailureContext,
) {}

/** Deterministic development requested an input without a registered fixture. */
export class ModelFixtureMissing extends Schema.TaggedError<ModelFixtureMissing>()(
  "ModelFixtureMissing",
  {
    inputDigest: ModelInputDigest,
    operation: ModelOperationName,
  },
) {}

/** Every expected, content-safe failure exposed by one provider-attempt adapter. */
export type ModelGatewayError =
  | ModelFixtureMissing
  | ModelProviderConnectionLost
  | ModelProviderEmptyResponse
  | ModelProviderHttp5xx
  | ModelProviderMalformedResponse
  | ModelProviderQuotaDenied
  | ModelProviderRateLimited
  | ModelProviderRefusal
  | ModelProviderRequestRejected
  | ModelProviderTruncated
  | ModelRequestDeadlineExceeded
  | ModelSchemaUnsupported
  | ModelStructuredOutputDecodingFailed;

/** Persisted completion disposition, independent of the observed failure identity. */
export type ModelCompletionDisposition =
  "succeeded" | "explicitly_rejected" | "invalid_output" | "outcome_unknown";

/** Persisted retry decision made only by the durable operation authority. */
export type ModelRetryPlan =
  | { readonly _tag: "None" }
  | { readonly _tag: "ScheduleTransientRateLimit"; readonly delayMilliseconds: number };

/** Content-free classification stored after an observed gateway failure. */
export interface ModelGatewayFailureClassification {
  readonly disposition: Exclude<ModelCompletionDisposition, "succeeded">;
  readonly observedFailure: ModelGatewayError["_tag"];
  readonly retryPlan: ModelRetryPlan;
}

/** Classify one observable failure without relying on provider retry hints. */
export function classifyModelGatewayFailure(
  failure: ModelGatewayError,
  policy: { readonly transientRateLimitRetryAvailable: boolean },
): ModelGatewayFailureClassification {
  if (failure instanceof ModelProviderRateLimited) {
    const maySchedule =
      failure.classification === "transient" &&
      failure.retryAfterMilliseconds <= 1_000 &&
      policy.transientRateLimitRetryAvailable;
    return {
      disposition: "explicitly_rejected",
      observedFailure: failure._tag,
      retryPlan: maySchedule
        ? {
            _tag: "ScheduleTransientRateLimit",
            delayMilliseconds: failure.retryAfterMilliseconds,
          }
        : { _tag: "None" },
    };
  }

  if (
    failure instanceof ModelRequestDeadlineExceeded ||
    failure instanceof ModelProviderConnectionLost ||
    failure instanceof ModelProviderEmptyResponse ||
    failure instanceof ModelProviderMalformedResponse ||
    failure instanceof ModelProviderHttp5xx
  ) {
    return {
      disposition: "outcome_unknown",
      observedFailure: failure._tag,
      retryPlan: { _tag: "None" },
    };
  }

  if (
    failure instanceof ModelProviderTruncated ||
    failure instanceof ModelStructuredOutputDecodingFailed
  ) {
    return {
      disposition: "invalid_output",
      observedFailure: failure._tag,
      retryPlan: { _tag: "None" },
    };
  }

  return {
    disposition: "explicitly_rejected",
    observedFailure: failure._tag,
    retryPlan: { _tag: "None" },
  };
}

/** Derive the provider schema directly from the authoritative Effect Schema. */
export function makeProviderJsonSchema<A, I>(
  schema: Schema.Schema<A, I, never>,
): JSONSchema.JsonSchema7Root {
  return JSONSchema.make(schema, { target: "jsonSchema7" });
}

/** Content-safe usage counters returned by a provider attempt. */
export interface ModelTokenUsage {
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

/** Successful, decoded result of exactly one provider dispatch. */
export interface ModelGatewaySuccess<A> {
  readonly costMicroUsd: number;
  readonly finishReason: "stop";
  readonly output: A;
  readonly providerRequestId: string | null;
  readonly usage: ModelTokenUsage;
}

/** One already-authorized provider dispatch. */
export interface ModelGatewayRequest<A, I> {
  readonly attemptId: ModelAttemptId;
  readonly attemptOrdinal: number;
  readonly canonicalInput: string;
  readonly inputDigest: ModelInputDigest;
  readonly model: string;
  readonly operation: ModelOperationName;
  readonly operationId: ModelOperationId;
  readonly outputSchema: Schema.Schema<A, I, never>;
  readonly outputTokenLimit: number;
  readonly promptVersion: number;
  readonly provider: "openai" | "deterministic";
  readonly providerTimeoutMilliseconds: number;
  readonly schemaVersion: number;
  readonly totalDeadlineMilliseconds: number;
}

/** Application-owned model port; implementations execute exactly one already-authorized attempt. */
export interface ModelGatewayService {
  readonly execute: <A, I>(
    request: ModelGatewayRequest<A, I>,
  ) => Effect.Effect<ModelGatewaySuccess<A>, ModelGatewayError>;
}

/** Effect service tag that hides every provider SDK type from callers. */
export class ModelGateway extends Context.Tag("@xpensego/domain/model/ModelGateway")<
  ModelGateway,
  ModelGatewayService
>() {}
