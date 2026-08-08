import { Schema } from "effect";

const ExtractedTransactionSuggestion = Schema.Struct({
  _tag: Schema.Literal("Extracted"),
  amountMinor: Schema.Int.pipe(Schema.positive()).annotations({
    description: "Positive integer monetary value in minor currency units.",
  }),
  counterparty: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  currency: Schema.Literal("INR"),
  direction: Schema.Literal("debit", "credit"),
  occurredOn: Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/)),
  requiresReview: Schema.Boolean,
});

const TransactionClarificationRequired = Schema.Struct({
  _tag: Schema.Literal("ClarificationRequired"),
  reason: Schema.Literal(
    "missing_amount",
    "ambiguous_amount",
    "missing_direction",
    "missing_date",
    "ambiguous_date",
    "missing_counterparty",
  ),
});

/**
 * Structured outcome produced by the bounded single-transaction extraction operation.
 * Incomplete input must request clarification instead of inventing financial fields.
 */
export const TransactionExtractionSuggestion = Schema.Union(
  ExtractedTransactionSuggestion,
  TransactionClarificationRequired,
);

/** A decoded single-transaction extraction suggestion. */
export type TransactionExtractionSuggestion = typeof TransactionExtractionSuggestion.Type;

/** Root-object provider contract for one extraction outcome. */
export const TransactionExtractionResult = Schema.Struct({
  outcome: TransactionExtractionSuggestion,
});

/** A decoded single-transaction extraction result. */
export type TransactionExtractionResult = typeof TransactionExtractionResult.Type;

/** Structured suggestions produced by the bounded five-record extraction operation. */
export const TransactionExtractionBatchSuggestion = Schema.Struct({
  suggestions: Schema.Array(TransactionExtractionSuggestion).pipe(
    Schema.minItems(1),
    Schema.maxItems(5),
  ),
});

/** A decoded bounded extraction batch. */
export type TransactionExtractionBatchSuggestion = typeof TransactionExtractionBatchSuggestion.Type;
