import { ModelOperationId } from "@xpensego/contracts/model/model-operation-job";
import { Effect, Layer, Ref, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ModelAttemptId,
  ModelGateway,
  ModelInputDigest,
  ModelStructuredOutputDecodingFailed,
  type ModelGatewayService,
} from "./model-gateway.js";
import {
  ModelOperationStore,
  type ModelOperationStoreService,
  executePreparedModelOperation,
} from "./model-operation.js";
import { TransactionExtractionResult } from "./transaction-extraction.js";

const operationId = Schema.decodeUnknownSync(ModelOperationId)(
  "913c7c0b-b6f9-47f2-8174-a8267edc9bba",
);
const attemptId = Schema.decodeUnknownSync(ModelAttemptId)("71de1431-f735-4a43-813a-ea0c747cb376");

const gatewayOutput = {
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

const claim = {
  _tag: "Claimed",
  attempt: {
    attemptId,
    attemptOrdinal: 1,
    canonicalInput: "Synthetic purchase INR 123.45 at Synthetic Grocer",
    inputDigest: Schema.decodeUnknownSync(ModelInputDigest)(
      "b210bc2b392265c489c8f87f9ba607d1868896da59676c08dfd194057695e4d2",
    ),
    model: "gpt-5.4-nano-2026-03-17",
    operation: "transaction.extract.v1",
    operationId,
    outputTokenLimit: 256,
    promptVersion: 1,
    provider: "openai",
    providerTimeoutMilliseconds: 3_000,
    schemaVersion: 1,
    totalDeadlineMilliseconds: 4_000,
    transientRateLimitRetryAvailable: true,
  },
} as const;

describe("durable Model Operation execution", () => {
  it("lets a durable claim authorize one gateway call across duplicate execution", async () => {
    const program = Effect.gen(function* () {
      const claims = yield* Ref.make(0);
      const dispatches = yield* Ref.make(0);
      const completions = yield* Ref.make(0);

      const store: ModelOperationStoreService = {
        prepare: (input) => Effect.succeed({ _tag: "Prepared", operationId: input.operationId }),
        claim: () =>
          Ref.getAndUpdate(claims, (value) => value + 1).pipe(
            Effect.map((claimNumber) =>
              claimNumber === 0
                ? claim
                : ({
                    _tag: "Completed",
                    completion: {
                      disposition: "succeeded",
                      observedFailure: null,
                      retryPlan: { _tag: "None" },
                    },
                  } as const),
            ),
          ),
        complete: (input) =>
          Ref.update(completions, (value) => value + 1).pipe(Effect.as(input.completion)),
        restart: (input) =>
          Effect.succeed({ _tag: "Restarted", operationId: input.restartedOperationId }),
      };
      const gateway: ModelGatewayService = {
        execute: (request) =>
          Ref.update(dispatches, (value) => value + 1).pipe(
            Effect.zipRight(Schema.decodeUnknown(request.outputSchema)(gatewayOutput)),
            Effect.mapError(
              () =>
                new ModelStructuredOutputDecodingFailed({
                  attemptOrdinal: request.attemptOrdinal,
                  model: request.model,
                  operation: request.operation,
                  provider: request.provider,
                }),
            ),
            Effect.map((output) => ({
              costMicroUsd: 77,
              finishReason: "stop" as const,
              output,
              providerRequestId: "req_synthetic_01",
              usage: {
                cachedInputTokens: 0,
                inputTokens: 40,
                outputTokens: 28,
                reasoningTokens: 0,
              },
            })),
          ),
      };
      const layer = Layer.merge(
        Layer.succeed(ModelOperationStore, store),
        Layer.succeed(ModelGateway, gateway),
      );

      const first = yield* executePreparedModelOperation({
        operationId,
        outputSchema: TransactionExtractionResult,
      }).pipe(Effect.provide(layer));
      const duplicate = yield* executePreparedModelOperation({
        operationId,
        outputSchema: TransactionExtractionResult,
      }).pipe(Effect.provide(layer));

      return {
        completionCount: yield* Ref.get(completions),
        dispatchCount: yield* Ref.get(dispatches),
        duplicate,
        first,
      };
    });

    const result = await Effect.runPromise(program);
    expect(result.first).toMatchObject({ _tag: "Succeeded", output: gatewayOutput });
    expect(result.duplicate).toMatchObject({
      _tag: "AlreadyCompleted",
      completion: { disposition: "succeeded" },
    });
    expect(result.dispatchCount).toBe(1);
    expect(result.completionCount).toBe(1);
  });

  it("keeps deterministic domain rejection separate from provider adapter failures", async () => {
    const store: ModelOperationStoreService = {
      prepare: (input) => Effect.succeed({ _tag: "Prepared", operationId: input.operationId }),
      claim: () => Effect.succeed(claim),
      complete: (input) => Effect.succeed(input.completion),
      restart: (input) =>
        Effect.succeed({ _tag: "Restarted", operationId: input.restartedOperationId }),
    };
    const gateway: ModelGatewayService = {
      execute: (request) =>
        Schema.decodeUnknown(request.outputSchema)({
          outcome: { ...gatewayOutput.outcome, occurredOn: "2026-02-30" },
        }).pipe(
          Effect.mapError(
            () =>
              new ModelStructuredOutputDecodingFailed({
                attemptOrdinal: request.attemptOrdinal,
                model: request.model,
                operation: request.operation,
                provider: request.provider,
              }),
          ),
          Effect.map((output) => ({
            costMicroUsd: 77,
            finishReason: "stop" as const,
            output,
            providerRequestId: "req_synthetic_invalid_date",
            usage: {
              cachedInputTokens: 0,
              inputTokens: 40,
              outputTokens: 28,
              reasoningTokens: 0,
            },
          })),
        ),
    };
    const layer = Layer.merge(
      Layer.succeed(ModelOperationStore, store),
      Layer.succeed(ModelGateway, gateway),
    );

    const outcome = await Effect.runPromise(
      executePreparedModelOperation({
        operationId,
        outputSchema: TransactionExtractionResult,
      }).pipe(Effect.provide(layer)),
    );

    expect(outcome).toEqual({
      _tag: "Failed",
      completion: {
        disposition: "invalid_output",
        observedFailure: "ModelOperationDomainValidationRejected",
        retryPlan: { _tag: "None" },
      },
    });
  });
});
