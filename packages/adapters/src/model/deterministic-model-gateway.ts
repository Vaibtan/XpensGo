import {
  ModelFixtureMissing,
  ModelGateway,
  ModelStructuredOutputDecodingFailed,
  type ModelCompletionDisposition,
  type ModelGatewayError,
  type ModelGatewayRequest,
  type ModelGatewayService,
  type ModelInputDigest,
  type ModelOperationName,
  type ModelRetryPlan,
  type ModelTokenUsage,
} from "@xpensego/domain/model/model-gateway";
import { Duration, Effect, Layer, Ref, Schema } from "effect";

/** One synthetic scripted provider response. */
export type DeterministicModelFixtureOutcome =
  | {
      readonly _tag: "Success";
      readonly costMicroUsd: number;
      readonly output: unknown;
      readonly usage: ModelTokenUsage;
    }
  | { readonly _tag: "Failure"; readonly error: ModelGatewayError };

/** Content-safe fixture addressed without inspecting raw canonical input. */
export interface DeterministicModelFixture {
  readonly artificialLatencyMilliseconds: number;
  readonly expectedDisposition: ModelCompletionDisposition;
  readonly expectedRetryPlan: ModelRetryPlan;
  readonly inputDigest: ModelInputDigest;
  readonly model: "gpt-5.4-nano-2026-03-17";
  readonly operation: ModelOperationName;
  readonly promptVersion: number;
  readonly schemaVersion: number;
  readonly script: readonly [
    DeterministicModelFixtureOutcome,
    ...ReadonlyArray<DeterministicModelFixtureOutcome>,
  ];
}

function fixtureKey(input: {
  readonly inputDigest: ModelInputDigest;
  readonly model: string;
  readonly operation: ModelOperationName;
  readonly promptVersion: number;
  readonly schemaVersion: number;
}): string {
  return [
    input.operation,
    input.model,
    input.promptVersion,
    input.schemaVersion,
    input.inputDigest,
  ].join(":");
}

/** Build an isolated deterministic gateway with atomic per-operation script consumption. */
export function makeDeterministicModelGateway(
  fixtures: ReadonlyArray<DeterministicModelFixture>,
): Effect.Effect<ModelGatewayService> {
  return Effect.gen(function* () {
    const fixtureIndex = new Map(fixtures.map((fixture) => [fixtureKey(fixture), fixture]));
    const consumed = yield* Ref.make(new Map<string, number>());

    const execute: ModelGatewayService["execute"] = <A, I>(request: ModelGatewayRequest<A, I>) =>
      Effect.gen(function* () {
        const fixture = fixtureIndex.get(fixtureKey(request));
        if (fixture === undefined) {
          return yield* new ModelFixtureMissing({
            inputDigest: request.inputDigest,
            operation: request.operation,
          });
        }

        const consumptionKey = `${request.operationId}:${fixtureKey(request)}`;
        const outcome = yield* Ref.modify(consumed, (state) => {
          const index = state.get(consumptionKey) ?? 0;
          const next = new Map(state);
          next.set(consumptionKey, index + 1);
          return [fixture.script[index] ?? null, next] as const;
        });
        if (outcome === null) {
          return yield* new ModelFixtureMissing({
            inputDigest: request.inputDigest,
            operation: request.operation,
          });
        }

        if (fixture.artificialLatencyMilliseconds > 0) {
          yield* Effect.sleep(Duration.millis(fixture.artificialLatencyMilliseconds));
        }
        if (outcome._tag === "Failure") {
          return yield* outcome.error;
        }

        const output = yield* Schema.decodeUnknown(request.outputSchema)(outcome.output).pipe(
          Effect.mapError(
            () =>
              new ModelStructuredOutputDecodingFailed({
                attemptOrdinal: request.attemptOrdinal,
                model: request.model,
                operation: request.operation,
                provider: request.provider,
              }),
          ),
        );
        return {
          costMicroUsd: outcome.costMicroUsd,
          finishReason: "stop",
          output,
          providerRequestId: null,
          usage: outcome.usage,
        };
      });

    return ModelGateway.of({ execute });
  });
}

/** Build an invocation-scoped deterministic Model Gateway Layer. */
export function makeDeterministicModelGatewayLayer(
  fixtures: ReadonlyArray<DeterministicModelFixture>,
) {
  return Layer.effect(ModelGateway, makeDeterministicModelGateway(fixtures));
}
