import { Schema } from "effect";

/** Identifier for one durable asynchronous job. */
export const JobId = Schema.UUID.pipe(Schema.brand("JobId"));

/** A parsed durable job identifier. */
export type JobId = typeof JobId.Type;
