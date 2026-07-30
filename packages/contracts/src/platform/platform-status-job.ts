import { Schema } from "effect";

import { CorrelationId } from "./correlation-id.js";
import { JobId } from "./job-id.js";

/** Version 1 Queue request for the platform status tracer. */
export const PlatformStatusJobV1 = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("platform.status.requested"),
  jobId: JobId,
  correlationId: CorrelationId,
});

/** A parsed version 1 platform status Queue request. */
export type PlatformStatusJobV1 = typeof PlatformStatusJobV1.Type;
