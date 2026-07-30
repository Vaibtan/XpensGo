import { Schema } from "effect";

/** Correlation identifier parsed at an ingress boundary. */
export const CorrelationId = Schema.UUID.pipe(Schema.brand("CorrelationId"));

/** A parsed correlation identifier. */
export type CorrelationId = typeof CorrelationId.Type;
