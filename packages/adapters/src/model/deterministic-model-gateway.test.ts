import { ModelOperationId } from "@xpensego/contracts/model/model-operation-job";
import {
  ModelAttemptId,
  ModelFixtureMissing,
  ModelInputDigest,
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
  classifyModelGatewayFailure,
} from "@xpensego/domain/model/model-gateway";
import { TransactionExtractionResult } from "@xpensego/domain/model/transaction-extraction";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  makeDeterministicModelGateway,
  type DeterministicModelFixture,
} from "./deterministic-model-gateway.js";

const operationId = Schema.decodeUnknownSync(ModelOperationId)(
  "913c7c0b-b6f9-47f2-8174-a8267edc9bba",
);
const attemptId = Schema.decodeUnknownSync(ModelAttemptId)("71de1431-f735-4a43-813a-ea0c747cb376");
const output = {
  outcome: {
    _tag: "Extracted",
    amountMinor: 12_345,
    counterparty: "Synthetic Grocer",
    currency: "INR",
    direction: "debit",
    occurredOn: "2026-08-08",
    requiresReview: false,
  },
} as const;

function digest(character: string) {
  return Schema.decodeUnknownSync(ModelInputDigest)(character.repeat(64));
}

function request(inputDigest: typeof ModelInputDigest.Type, attemptOrdinal = 1) {
  return {
    attemptId,
    attemptOrdinal,
    canonicalInput: "Synthetic purchase INR 123.45 at Synthetic Grocer",
    inputDigest,
    model: "gpt-5.4-nano-2026-03-17",
    operation: "transaction.extract.v1" as const,
    operationId,
    outputSchema: TransactionExtractionResult,
    outputTokenLimit: 256,
    promptVersion: 1,
    provider: "deterministic" as const,
    providerTimeoutMilliseconds: 3_000,
    schemaVersion: 1,
    totalDeadlineMilliseconds: 4_000,
  };
}

const context = {
  attemptOrdinal: 1,
  model: "gpt-5.4-nano-2026-03-17",
  operation: "transaction.extract.v1" as const,
  provider: "deterministic" as const,
};

describe("deterministic model gateway", () => {
  it("decodes synthetic output and records deterministic usage and cost", async () => {
    const inputDigest = digest("a");
    const fixture: DeterministicModelFixture = {
      artificialLatencyMilliseconds: 0,
      expectedDisposition: "succeeded",
      expectedRetryPlan: { _tag: "None" },
      inputDigest,
      model: "gpt-5.4-nano-2026-03-17",
      operation: "transaction.extract.v1",
      promptVersion: 1,
      schemaVersion: 1,
      script: [
        {
          _tag: "Success",
          costMicroUsd: 77,
          output,
          usage: {
            cachedInputTokens: 0,
            inputTokens: 40,
            outputTokens: 28,
            reasoningTokens: 0,
          },
        },
      ],
    };
    const gateway = await Effect.runPromise(makeDeterministicModelGateway([fixture]));

    const result = await Effect.runPromise(gateway.execute(request(inputDigest)));

    expect(result).toMatchObject({ costMicroUsd: 77, finishReason: "stop", output });
  });

  it("keeps observed errors, disposition, and retry plans independent", async () => {
    const cases = [
      [
        "b",
        new ModelRequestDeadlineExceeded({ ...context, timeoutMilliseconds: 3_000 }),
        "outcome_unknown",
      ],
      ["c", new ModelProviderConnectionLost(context), "outcome_unknown"],
      ["d", new ModelProviderEmptyResponse(context), "outcome_unknown"],
      ["e", new ModelProviderMalformedResponse(context), "outcome_unknown"],
      ["f", new ModelProviderHttp5xx({ ...context, status: 503 }), "outcome_unknown"],
      ["1", new ModelProviderQuotaDenied(context), "explicitly_rejected"],
      ["2", new ModelProviderRequestRejected({ ...context, status: 401 }), "explicitly_rejected"],
      ["3", new ModelProviderRefusal(context), "explicitly_rejected"],
      ["4", new ModelProviderTruncated(context), "invalid_output"],
      ["5", new ModelStructuredOutputDecodingFailed(context), "invalid_output"],
      [
        "8",
        new ModelProviderRateLimited({
          ...context,
          classification: "quota",
          retryAfterMilliseconds: 60_000,
        }),
        "explicitly_rejected",
      ],
      ["9", new ModelSchemaUnsupported({ ...context, schemaVersion: 1 }), "explicitly_rejected"],
    ] as const;
    const fixtures = cases.map(
      ([character, error, expectedDisposition]): DeterministicModelFixture => ({
        artificialLatencyMilliseconds: 0,
        expectedDisposition,
        expectedRetryPlan: { _tag: "None" },
        inputDigest: digest(character),
        model: "gpt-5.4-nano-2026-03-17",
        operation: "transaction.extract.v1",
        promptVersion: 1,
        schemaVersion: 1,
        script: [{ _tag: "Failure", error }],
      }),
    );
    const gateway = await Effect.runPromise(makeDeterministicModelGateway(fixtures));

    for (const [character, error, expectedDisposition] of cases) {
      const observed = await Effect.runPromise(
        gateway.execute(request(digest(character))).pipe(Effect.flip),
      );
      const classified = classifyModelGatewayFailure(observed, {
        transientRateLimitRetryAvailable: true,
      });
      expect(observed._tag).toBe(error._tag);
      expect(classified).toEqual({
        disposition: expectedDisposition,
        observedFailure: error._tag,
        retryPlan: { _tag: "None" },
      });
    }
  });

  it("consumes one scripted outcome per authorized attempt and fails closed", async () => {
    const inputDigest = digest("6");
    const fixture: DeterministicModelFixture = {
      artificialLatencyMilliseconds: 0,
      expectedDisposition: "explicitly_rejected",
      expectedRetryPlan: {
        _tag: "ScheduleTransientRateLimit",
        delayMilliseconds: 250,
      },
      inputDigest,
      model: "gpt-5.4-nano-2026-03-17",
      operation: "transaction.extract.v1",
      promptVersion: 1,
      schemaVersion: 1,
      script: [
        {
          _tag: "Failure",
          error: new ModelProviderRateLimited({
            ...context,
            classification: "transient",
            retryAfterMilliseconds: 250,
          }),
        },
        {
          _tag: "Success",
          costMicroUsd: 77,
          output,
          usage: {
            cachedInputTokens: 0,
            inputTokens: 40,
            outputTokens: 28,
            reasoningTokens: 0,
          },
        },
      ],
    };
    const gateway = await Effect.runPromise(makeDeterministicModelGateway([fixture]));

    const first = await Effect.runPromise(gateway.execute(request(inputDigest)).pipe(Effect.flip));
    const second = await Effect.runPromise(gateway.execute(request(inputDigest, 2)));
    const exhausted = await Effect.runPromise(
      gateway.execute(request(inputDigest, 3)).pipe(Effect.flip),
    );
    const unregistered = await Effect.runPromise(
      gateway.execute(request(digest("7"))).pipe(Effect.flip),
    );

    expect(first._tag).toBe("ModelProviderRateLimited");
    expect(second.output).toEqual(output);
    expect(exhausted).toBeInstanceOf(ModelFixtureMissing);
    expect(unregistered).toBeInstanceOf(ModelFixtureMissing);
  });
});
