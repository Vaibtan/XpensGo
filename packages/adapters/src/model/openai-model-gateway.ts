import { createOpenAI, type OpenAIProviderSettings } from "@ai-sdk/openai";
import {
  APICallError,
  EmptyResponseBodyError,
  InvalidResponseDataError,
  JSONParseError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  UnsupportedFunctionalityError,
  generateText,
  jsonSchema,
} from "ai";
import {
  ModelGateway,
  ModelProviderConnectionLost,
  ModelProviderEmptyResponse,
  ModelProviderHttp5xx,
  ModelProviderMalformedResponse,
  ModelProviderQuotaDenied,
  ModelProviderRateLimited,
  ModelProviderRefusal,
  ModelProviderRequestRejected,
  ModelProviderTruncated,
  ModelRequestDeadlineExceeded,
  ModelSchemaUnsupported,
  ModelStructuredOutputDecodingFailed,
  type ModelGatewayError,
  type ModelGatewayRequest,
  type ModelGatewayService,
  type ModelOperationName,
  makeProviderJsonSchema,
} from "@xpensego/domain/model/model-gateway";
import { Effect, Either, Layer, Redacted, Schema } from "effect";

/** Invocation-scoped OpenAI adapter configuration. */
export interface OpenAIModelGatewayConfig {
  readonly apiKey: Redacted.Redacted<string>;
  readonly fetch?: OpenAIProviderSettings["fetch"];
}

const instructionsByOperation = {
  "query.slots.v1":
    "Extract only the supported query intent and slots. Never answer the query or invent values.",
  "transaction.extract.v1":
    "Extract exactly one transaction. Set outcome to Extracted only when amount, direction, date, and counterparty are explicit and unambiguous. Otherwise set outcome to ClarificationRequired with the most relevant reason. Never infer or invent financial fields. Set requiresReview when explicit source wording still warrants user confirmation.",
  "transaction.extract_many.v1":
    "Extract at most five transactions in source order. For each item return Extracted only when amount, direction, date, and counterparty are explicit and unambiguous; otherwise return ClarificationRequired. Never infer or invent financial fields.",
} as const satisfies Record<ModelOperationName, string>;

function failureContext(request: {
  readonly attemptOrdinal: number;
  readonly model: string;
  readonly operation: ModelOperationName;
  readonly provider: "openai" | "deterministic";
}) {
  return {
    attemptOrdinal: request.attemptOrdinal,
    model: request.model,
    operation: request.operation,
    provider: request.provider,
  } as const;
}

function namedCause(error: unknown, expectedName: string, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { readonly cause?: unknown; readonly name?: unknown };
  return candidate.name === expectedName || namedCause(candidate.cause, expectedName, depth + 1);
}

function sdkCause(error: unknown, predicate: (candidate: unknown) => boolean, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) {
    return false;
  }
  if (predicate(error)) {
    return true;
  }
  return sdkCause((error as { readonly cause?: unknown }).cause, predicate, depth + 1);
}

function parseRetryAfterMilliseconds(headers: Record<string, string> | undefined): number | null {
  if (headers === undefined) {
    return null;
  }
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const milliseconds = normalized.get("retry-after-ms");
  const retryAfter = normalized.get("retry-after");
  let parsed: number;
  if (milliseconds !== undefined) {
    parsed = Number(milliseconds);
  } else if (retryAfter !== undefined && Number.isFinite(Number(retryAfter))) {
    parsed = Number(retryAfter) * 1_000;
  } else if (retryAfter !== undefined) {
    parsed = Date.parse(retryAfter) - Date.now();
  } else {
    return null;
  }
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 60_000 ? Math.ceil(parsed) : null;
}

function mapOpenAIError<A, I>(
  error: unknown,
  request: ModelGatewayRequest<A, I>,
  observedHttpStatus: number | undefined,
): ModelGatewayError {
  const context = failureContext(request);

  if (NoObjectGeneratedError.isInstance(error)) {
    if (error.finishReason === "length") {
      return new ModelProviderTruncated(context);
    }
    if (error.finishReason === "content-filter") {
      return new ModelProviderRefusal(context);
    }
    return new ModelStructuredOutputDecodingFailed(context);
  }
  if (
    sdkCause(
      error,
      (candidate) =>
        NoOutputGeneratedError.isInstance(candidate) ||
        EmptyResponseBodyError.isInstance(candidate),
    )
  ) {
    return new ModelProviderEmptyResponse(context);
  }
  if (
    APICallError.isInstance(error) &&
    observedHttpStatus === 200 &&
    error.responseBody?.length === 0
  ) {
    return new ModelProviderEmptyResponse(context);
  }
  if (
    sdkCause(
      error,
      (candidate) =>
        InvalidResponseDataError.isInstance(candidate) || JSONParseError.isInstance(candidate),
    )
  ) {
    return new ModelProviderMalformedResponse(context);
  }
  if (UnsupportedFunctionalityError.isInstance(error)) {
    return new ModelSchemaUnsupported({ ...context, schemaVersion: request.schemaVersion });
  }
  if (APICallError.isInstance(error)) {
    if (observedHttpStatus === 200) {
      return error.responseBody?.length === 0
        ? new ModelProviderEmptyResponse(context)
        : new ModelProviderMalformedResponse(context);
    }
    const status = observedHttpStatus ?? error.statusCode;
    if (status === 429) {
      if (isQuotaOrActionRequired(error.responseBody)) {
        return new ModelProviderQuotaDenied(context);
      }
      const retryAfterMilliseconds = parseRetryAfterMilliseconds(error.responseHeaders);
      return new ModelProviderRateLimited({
        ...context,
        classification: "transient",
        retryAfterMilliseconds: retryAfterMilliseconds ?? 60_000,
      });
    }
    if (status === 402) {
      return new ModelProviderQuotaDenied(context);
    }
    if (status !== undefined && status >= 500 && status <= 599) {
      return new ModelProviderHttp5xx({ ...context, status });
    }
    if (status !== undefined && status >= 400 && status <= 599) {
      return new ModelProviderRequestRejected({ ...context, status });
    }
    if (namedCause(error, "TimeoutError") || namedCause(error, "AbortError")) {
      return new ModelRequestDeadlineExceeded({
        ...context,
        timeoutMilliseconds: request.totalDeadlineMilliseconds,
      });
    }
    return new ModelProviderConnectionLost(context);
  }
  if (namedCause(error, "TimeoutError") || namedCause(error, "AbortError")) {
    return new ModelRequestDeadlineExceeded({
      ...context,
      timeoutMilliseconds: request.totalDeadlineMilliseconds,
    });
  }
  if (namedCause(error, "TypeError")) {
    return new ModelProviderConnectionLost(context);
  }
  return new ModelProviderMalformedResponse(context);
}

function requestId(headers: Record<string, string> | undefined): string | null {
  if (headers === undefined) {
    return null;
  }
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-request-id");
  return entry?.[1] ?? null;
}

function isQuotaOrActionRequired(responseBody: string | undefined): boolean {
  if (responseBody === undefined || responseBody.length > 16_384) {
    return false;
  }
  try {
    const parsed = JSON.parse(responseBody) as {
      readonly error?: { readonly code?: unknown; readonly type?: unknown };
    };
    const classification = [parsed.error?.code, parsed.error?.type]
      .filter((value): value is string => typeof value === "string")
      .join(":")
      .toLowerCase();
    return ["quota", "billing", "credit", "spend", "action_required"].some((marker) =>
      classification.includes(marker),
    );
  } catch {
    return false;
  }
}

function computeNanoCostMicroUsd(inputTokens: number, outputTokens: number): number {
  return Math.ceil(inputTokens * 0.2 + outputTokens * 1.25);
}

/** Create the sole provider-backed Model Gateway adapter for one Worker invocation. */
export function makeOpenAIModelGateway(config: OpenAIModelGatewayConfig): ModelGatewayService {
  const execute: ModelGatewayService["execute"] = <A, I>(request: ModelGatewayRequest<A, I>) =>
    Effect.gen(function* () {
      let observedHttpStatus: number | undefined;
      const baseFetch = config.fetch ?? globalThis.fetch;
      const observedFetch: NonNullable<OpenAIProviderSettings["fetch"]> = async (input, init) => {
        const response = await baseFetch(input, init);
        observedHttpStatus = response.status;
        return response;
      };
      const openai = createOpenAI({
        apiKey: Redacted.value(config.apiKey),
        fetch: observedFetch,
      });
      const providerSchema = yield* Effect.try({
        try: () => makeProviderJsonSchema(request.outputSchema),
        catch: () =>
          new ModelSchemaUnsupported({
            ...failureContext(request),
            schemaVersion: request.schemaVersion,
          }),
      });
      const outputSchema = jsonSchema<A>(providerSchema, {
        validate: (value) => {
          const decoded = Schema.decodeUnknownEither(request.outputSchema)(value);
          return Either.isRight(decoded)
            ? { success: true, value: decoded.right }
            : { success: false, error: new Error("Effect Schema validation failed") };
        },
      });
      const generated = yield* Effect.tryPromise({
        try: () =>
          generateText({
            headers: { "X-Client-Request-Id": request.attemptId },
            include: {
              requestBody: false,
              requestMessages: false,
              responseBody: false,
            },
            instructions: instructionsByOperation[request.operation],
            maxOutputTokens: request.outputTokenLimit,
            maxRetries: 0,
            model: openai.responses(request.model),
            output: Output.object({
              name: request.operation.replaceAll(".", "_"),
              schema: outputSchema,
            }),
            prompt: request.canonicalInput,
            providerOptions: {
              openai: {
                store: false,
                strictJsonSchema: true,
              },
            },
            telemetry: { isEnabled: false },
            timeout: {
              stepMs: request.providerTimeoutMilliseconds,
              totalMs: request.totalDeadlineMilliseconds,
            },
          }),
        catch: (error) => mapOpenAIError(error, request, observedHttpStatus),
      });

      if (generated.finishReason === "length") {
        return yield* new ModelProviderTruncated(failureContext(request));
      }
      if (generated.finishReason === "content-filter") {
        return yield* new ModelProviderRefusal(failureContext(request));
      }
      if (generated.finishReason !== "stop") {
        return yield* new ModelProviderMalformedResponse(failureContext(request));
      }

      const output = yield* Schema.decodeUnknown(request.outputSchema)(generated.output).pipe(
        Effect.mapError(() => new ModelStructuredOutputDecodingFailed(failureContext(request))),
      );
      const inputTokens = generated.usage.inputTokens ?? 0;
      const outputTokens = generated.usage.outputTokens ?? 0;
      return {
        costMicroUsd: computeNanoCostMicroUsd(inputTokens, outputTokens),
        finishReason: "stop",
        output,
        providerRequestId: requestId(generated.response.headers),
        usage: {
          cachedInputTokens: generated.usage.inputTokenDetails.cacheReadTokens ?? 0,
          inputTokens,
          outputTokens,
          reasoningTokens: generated.usage.outputTokenDetails.reasoningTokens ?? 0,
        },
      };
    });

  return ModelGateway.of({ execute });
}

/** Build an invocation-scoped OpenAI Model Gateway Layer. */
export function makeOpenAIModelGatewayLayer(config: OpenAIModelGatewayConfig) {
  return Layer.succeed(ModelGateway, makeOpenAIModelGateway(config));
}
