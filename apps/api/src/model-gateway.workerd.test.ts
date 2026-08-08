import { makeOpenAIModelGateway } from "@xpensego/adapters/model/openai-model-gateway";
import { ModelOperationId } from "@xpensego/contracts/model/model-operation-job";
import { ModelAttemptId, ModelInputDigest } from "@xpensego/domain/model/model-gateway";
import { TransactionExtractionResult } from "@xpensego/domain/model/transaction-extraction";
import { modelGatewayExtractionCorpusV1 } from "@xpensego/testing/model/model-gateway-corpus";
import { Effect, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

describe("model gateway in Workerd", () => {
  it("keeps every versioned corpus digest and expected output authoritative", async () => {
    for (const fixture of modelGatewayExtractionCorpusV1) {
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(fixture.canonicalInput),
      );
      const digest = [...new Uint8Array(bytes)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");

      expect(digest).toBe(fixture.inputDigest);
      expect(Schema.decodeUnknownEither(TransactionExtractionResult)(fixture.expected)._tag).toBe(
        "Right",
      );
    }
  });

  it("runs one Effect-owned structured extraction without Node-only APIs", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          id: "resp_workerd_synthetic_01",
          created_at: 1_786_147_200,
          error: null,
          incomplete_details: null,
          model: "gpt-5.4-nano-2026-03-17",
          output: [
            {
              type: "message",
              role: "assistant",
              id: "msg_workerd_synthetic_01",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    outcome: {
                      _tag: "Extracted",
                      amountMinor: 12_345,
                      counterparty: "Synthetic Grocer",
                      currency: "INR",
                      direction: "debit",
                      occurredOn: "2026-08-08",
                      requiresReview: false,
                    },
                  }),
                  annotations: [],
                  logprobs: null,
                },
              ],
            },
          ],
          usage: {
            input_tokens: 40,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 28,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        }),
        {
          headers: {
            "content-type": "application/json",
            "x-request-id": "req_workerd_synthetic_01",
          },
        },
      );
    };
    const gateway = makeOpenAIModelGateway({
      apiKey: Redacted.make("sk-synthetic-not-a-real-secret"),
      fetch,
    });

    const result = await Effect.runPromise(
      gateway.execute({
        attemptId: Schema.decodeUnknownSync(ModelAttemptId)("71de1431-f735-4a43-813a-ea0c747cb376"),
        attemptOrdinal: 1,
        canonicalInput: "Synthetic purchase INR 123.45 at Synthetic Grocer",
        inputDigest: Schema.decodeUnknownSync(ModelInputDigest)(
          "b210bc2b392265c489c8f87f9ba607d1868896da59676c08dfd194057695e4d2",
        ),
        model: "gpt-5.4-nano-2026-03-17",
        operation: "transaction.extract.v1",
        operationId: Schema.decodeUnknownSync(ModelOperationId)(
          "913c7c0b-b6f9-47f2-8174-a8267edc9bba",
        ),
        outputSchema: TransactionExtractionResult,
        outputTokenLimit: 256,
        promptVersion: 1,
        provider: "openai",
        providerTimeoutMilliseconds: 3_000,
        schemaVersion: 1,
        totalDeadlineMilliseconds: 4_000,
      }),
    );

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      finishReason: "stop",
      providerRequestId: "req_workerd_synthetic_01",
      output: {
        outcome: {
          _tag: "Extracted",
          amountMinor: 12_345,
          currency: "INR",
          direction: "debit",
        },
      },
    });
  });
});
