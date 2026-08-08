import type { DeterministicModelFixture } from "@xpensego/adapters/model/deterministic-model-gateway";
import { ModelInputDigest } from "@xpensego/domain/model/model-gateway";
import { Schema } from "effect";

/** Synthetic fixture admitted for local Workerd and Queue replay proofs only. */
export const developmentModelFixtures: ReadonlyArray<DeterministicModelFixture> = [
  {
    artificialLatencyMilliseconds: 0,
    expectedDisposition: "succeeded",
    expectedRetryPlan: { _tag: "None" },
    inputDigest: Schema.decodeUnknownSync(ModelInputDigest)(
      "b210bc2b392265c489c8f87f9ba607d1868896da59676c08dfd194057695e4d2",
    ),
    model: "gpt-5.4-nano-2026-03-17",
    operation: "transaction.extract.v1",
    promptVersion: 1,
    schemaVersion: 1,
    script: [
      {
        _tag: "Success",
        costMicroUsd: 0,
        output: {
          outcome: {
            _tag: "Extracted",
            amountMinor: 12_345,
            counterparty: "Synthetic Grocer",
            currency: "INR",
            direction: "debit",
            occurredOn: "2026-08-08",
            requiresReview: false,
          },
        },
        usage: {
          cachedInputTokens: 0,
          inputTokens: 40,
          outputTokens: 28,
          reasoningTokens: 0,
        },
      },
    ],
  },
];
