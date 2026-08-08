import { ModelOperationId } from "@xpensego/contracts/model/model-operation-job";
import { ModelAttemptId, ModelInputDigest } from "@xpensego/domain/model/model-gateway";
import { TransactionExtractionResult } from "@xpensego/domain/model/transaction-extraction";
import { Effect, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { makeOpenAIModelGateway } from "./openai-model-gateway.js";

const operationId = Schema.decodeUnknownSync(ModelOperationId)(
  "913c7c0b-b6f9-47f2-8174-a8267edc9bba",
);
const attemptId = Schema.decodeUnknownSync(ModelAttemptId)("71de1431-f735-4a43-813a-ea0c747cb376");
const inputDigest = Schema.decodeUnknownSync(ModelInputDigest)(
  "b210bc2b392265c489c8f87f9ba607d1868896da59676c08dfd194057695e4d2",
);
const fixtureOutput = {
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

const request = {
  attemptId,
  attemptOrdinal: 1,
  canonicalInput: "Synthetic purchase INR 123.45 at Synthetic Grocer",
  inputDigest,
  model: "gpt-5.4-nano-2026-03-17",
  operation: "transaction.extract.v1" as const,
  operationId,
  outputSchema: TransactionExtractionResult,
  outputTokenLimit: 256,
  promptVersion: 1,
  provider: "openai" as const,
  providerTimeoutMilliseconds: 3_000,
  schemaVersion: 1,
  totalDeadlineMilliseconds: 4_000,
};

function successResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      id: "resp_synthetic_01",
      created_at: 1_786_147_200,
      error: null,
      incomplete_details: null,
      model: "gpt-5.4-nano-2026-03-17",
      output: [
        {
          type: "message",
          role: "assistant",
          id: "msg_synthetic_01",
          content: [
            {
              type: "output_text",
              text: JSON.stringify(fixtureOutput),
              annotations: [],
              logprobs: null,
            },
          ],
        },
      ],
      usage: {
        input_tokens: 40,
        input_tokens_details: { cached_tokens: 5 },
        output_tokens: 28,
        output_tokens_details: { reasoning_tokens: 2 },
      },
      ...overrides,
    }),
    {
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_synthetic_01",
      },
      status: 200,
    },
  );
}

function gateway(fetch: typeof globalThis.fetch) {
  return makeOpenAIModelGateway({
    apiKey: Redacted.make("sk-synthetic-not-a-real-secret"),
    fetch,
  });
}

describe("OpenAI model gateway", () => {
  it("pins the Responses request policy and revalidates Effect structured output", async () => {
    const observed: Array<{ body: Record<string, unknown>; headers: Headers; url: string }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a serialized JSON request body.");
      }
      observed.push({
        body: JSON.parse(init.body) as Record<string, unknown>,
        headers: new Headers(init?.headers),
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      });
      return successResponse();
    };

    const result = await Effect.runPromise(gateway(fetch).execute(request));

    expect(result).toEqual({
      costMicroUsd: 43,
      finishReason: "stop",
      output: fixtureOutput,
      providerRequestId: "req_synthetic_01",
      usage: {
        cachedInputTokens: 5,
        inputTokens: 40,
        outputTokens: 28,
        reasoningTokens: 2,
      },
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(observed[0]?.headers.get("x-client-request-id")).toBe(attemptId);
    expect(observed[0]?.body).toMatchObject({
      max_output_tokens: 256,
      model: "gpt-5.4-nano-2026-03-17",
      store: false,
    });
    expect(observed[0]?.body).not.toHaveProperty("previous_response_id");
  });

  it.each([
    {
      expected: "ModelProviderHttp5xx",
      response: () =>
        new Response(JSON.stringify({ error: { message: "redacted", type: "server_error" } }), {
          headers: { "content-type": "application/json" },
          status: 503,
        }),
    },
    {
      expected: "ModelProviderMalformedResponse",
      response: () =>
        new Response(JSON.stringify({ unexpected: true }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    },
    {
      expected: "ModelProviderEmptyResponse",
      response: () =>
        new Response(null, {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    },
  ])("maps $expected without SDK retries", async ({ expected, response }) => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return response();
    };

    const failure = await Effect.runPromise(gateway(fetch).execute(request).pipe(Effect.flip));

    expect(failure._tag).toBe(expected);
    expect(calls).toBe(1);
  });

  it("keeps explicit transient rate limiting separate from retry authorization", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "redacted", type: "rate_limit" } }), {
        headers: { "content-type": "application/json", "retry-after": "0.25" },
        status: 429,
      });

    const failure = await Effect.runPromise(gateway(fetch).execute(request).pipe(Effect.flip));

    expect(failure).toMatchObject({
      _tag: "ModelProviderRateLimited",
      classification: "transient",
      retryAfterMilliseconds: 250,
    });
  });

  it("keeps a quota 429 distinct even when the provider supplies Retry-After", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: { message: "redacted", type: "insufficient_quota", code: "insufficient_quota" },
        }),
        {
          headers: { "content-type": "application/json", "retry-after": "0.25" },
          status: 429,
        },
      );

    const failure = await Effect.runPromise(gateway(fetch).execute(request).pipe(Effect.flip));

    expect(failure._tag).toBe("ModelProviderQuotaDenied");
  });

  it.each([
    {
      expected: "ModelRequestDeadlineExceeded",
      rejection: () => new DOMException("redacted", "TimeoutError"),
    },
    {
      expected: "ModelProviderConnectionLost",
      rejection: () => new TypeError("redacted"),
    },
  ])("maps $expected without exposing raw causes", async ({ expected, rejection }) => {
    const fetch: typeof globalThis.fetch = async () => Promise.reject(rejection());

    const failure = await Effect.runPromise(gateway(fetch).execute(request).pipe(Effect.flip));

    expect(failure._tag).toBe(expected);
    expect(JSON.stringify(failure)).not.toContain("redacted");
  });
});
