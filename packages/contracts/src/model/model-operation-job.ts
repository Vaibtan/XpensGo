import { Schema } from "effect";

import { CorrelationId } from "../platform/correlation-id.js";

/** Stable identifier for one durable, budget-authorized model operation. */
export const ModelOperationId = Schema.UUID.pipe(Schema.brand("ModelOperationId"));

/** A parsed durable model-operation identifier. */
export type ModelOperationId = typeof ModelOperationId.Type;

/** Version 1 Queue wake-up for one already-persisted Model Operation. */
export const ModelOperationJobV1 = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("model.operation.ready"),
  operationId: ModelOperationId,
  correlationId: CorrelationId,
});

/** A parsed version 1 Model Operation Queue wake-up. */
export type ModelOperationJobV1 = typeof ModelOperationJobV1.Type;
