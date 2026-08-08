import { Schema } from "effect";

import type { ModelOperationName } from "./model-gateway.js";
import { QuerySlotsSuggestion } from "./query-slots.js";
import {
  TransactionExtractionBatchSuggestion,
  TransactionExtractionResult,
} from "./transaction-extraction.js";

/** Effect-owned output schemas for every enabled registry operation. */
export const modelOperationOutputSchemas = {
  "query.slots.v1": QuerySlotsSuggestion,
  "transaction.extract.v1": TransactionExtractionResult,
  "transaction.extract_many.v1": TransactionExtractionBatchSuggestion,
} as const satisfies Record<ModelOperationName, Schema.Schema.AnyNoContext>;

/** Resolve the authoritative output schema after a durable operation claim. */
export function modelOperationOutputSchema(
  operation: ModelOperationName,
): Schema.Schema.AnyNoContext {
  return modelOperationOutputSchemas[operation];
}
