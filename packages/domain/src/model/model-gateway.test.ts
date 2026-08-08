import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
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
  makeProviderJsonSchema,
} from "./model-gateway.js";
import {
  TransactionExtractionResult,
  TransactionExtractionSuggestion,
} from "./transaction-extraction.js";

const safeContext = {
  attemptOrdinal: 1,
  model: "gpt-5.4-nano-2026-03-17",
  operation: "transaction.extract.v1",
  provider: "openai",
} as const;

describe("Model Gateway contract", () => {
  it("derives a strict provider schema from the Effect output schema", () => {
    expect(makeProviderJsonSchema(TransactionExtractionResult)).toMatchInlineSnapshot(`
      {
        "$defs": {
          "Int": {
            "description": "an integer",
            "title": "int",
            "type": "integer",
          },
        },
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false,
        "properties": {
          "outcome": {
            "anyOf": [
              {
                "additionalProperties": false,
                "properties": {
                  "_tag": {
                    "enum": [
                      "Extracted",
                    ],
                    "type": "string",
                  },
                  "amountMinor": {
                    "$ref": "#/$defs/Int",
                    "description": "Positive integer monetary value in minor currency units.",
                    "exclusiveMinimum": 0,
                    "title": "positive",
                  },
                  "counterparty": {
                    "description": "a string at most 120 character(s) long",
                    "maxLength": 120,
                    "minLength": 1,
                    "title": "maxLength(120)",
                    "type": "string",
                  },
                  "currency": {
                    "enum": [
                      "INR",
                    ],
                    "type": "string",
                  },
                  "direction": {
                    "enum": [
                      "debit",
                      "credit",
                    ],
                    "type": "string",
                  },
                  "occurredOn": {
                    "description": "a string matching the pattern ^\\d{4}-\\d{2}-\\d{2}$",
                    "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
                    "type": "string",
                  },
                  "requiresReview": {
                    "type": "boolean",
                  },
                },
                "required": [
                  "_tag",
                  "amountMinor",
                  "counterparty",
                  "currency",
                  "direction",
                  "occurredOn",
                  "requiresReview",
                ],
                "type": "object",
              },
              {
                "additionalProperties": false,
                "properties": {
                  "_tag": {
                    "enum": [
                      "ClarificationRequired",
                    ],
                    "type": "string",
                  },
                  "reason": {
                    "enum": [
                      "missing_amount",
                      "ambiguous_amount",
                      "missing_direction",
                      "missing_date",
                      "ambiguous_date",
                      "missing_counterparty",
                    ],
                    "type": "string",
                  },
                },
                "required": [
                  "_tag",
                  "reason",
                ],
                "type": "object",
              },
            ],
          },
        },
        "required": [
          "outcome",
        ],
        "type": "object",
      }
    `);
  });

  it("revalidates structured output through the original Effect schema", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(TransactionExtractionSuggestion)({
        _tag: "Extracted",
        amountMinor: 12_345,
        counterparty: "Synthetic Grocer",
        currency: "INR",
        direction: "debit",
        occurredOn: "2026-08-08",
        requiresReview: false,
      }),
    );

    expect(decoded._tag).toBe("Extracted");
    if (decoded._tag !== "Extracted") {
      throw new Error("Expected an extracted transaction.");
    }
    expect(decoded.amountMinor).toBe(12_345);
    expect(
      Schema.decodeUnknownEither(TransactionExtractionSuggestion)({
        ...decoded,
        amountMinor: 123.45,
      })._tag,
    ).toBe("Left");

    expect(
      Schema.decodeUnknownEither(TransactionExtractionSuggestion)({
        _tag: "ClarificationRequired",
        reason: "missing_amount",
      })._tag,
    ).toBe("Right");
  });

  it("keeps observable failures orthogonal to disposition and retry plan", () => {
    const cases = [
      [new ModelSchemaUnsupported({ ...safeContext, schemaVersion: 1 }), "explicitly_rejected"],
      [
        new ModelProviderRateLimited({
          ...safeContext,
          classification: "transient",
          retryAfterMilliseconds: 500,
        }),
        "explicitly_rejected",
      ],
      [new ModelProviderQuotaDenied(safeContext), "explicitly_rejected"],
      [new ModelProviderRequestRejected({ ...safeContext, status: 400 }), "explicitly_rejected"],
      [new ModelProviderRefusal(safeContext), "explicitly_rejected"],
      [
        new ModelRequestDeadlineExceeded({ ...safeContext, timeoutMilliseconds: 3_000 }),
        "outcome_unknown",
      ],
      [new ModelProviderConnectionLost(safeContext), "outcome_unknown"],
      [new ModelProviderEmptyResponse(safeContext), "outcome_unknown"],
      [new ModelProviderMalformedResponse(safeContext), "outcome_unknown"],
      [new ModelProviderHttp5xx({ ...safeContext, status: 503 }), "outcome_unknown"],
      [new ModelProviderTruncated(safeContext), "invalid_output"],
      [new ModelStructuredOutputDecodingFailed(safeContext), "invalid_output"],
    ] as const;

    for (const [failure, disposition] of cases) {
      const classification = classifyModelGatewayFailure(failure, {
        transientRateLimitRetryAvailable: true,
      });
      expect(classification.disposition).toBe(disposition);
      expect(classification.observedFailure).toBe(failure._tag);
    }

    expect(
      classifyModelGatewayFailure(cases[1][0], {
        transientRateLimitRetryAvailable: true,
      }).retryPlan,
    ).toEqual({ _tag: "ScheduleTransientRateLimit", delayMilliseconds: 500 });
    expect(
      classifyModelGatewayFailure(cases[1][0], {
        transientRateLimitRetryAvailable: false,
      }).retryPlan,
    ).toEqual({ _tag: "None" });
  });
});
