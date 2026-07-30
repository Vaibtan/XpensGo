import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { JobId } from "@xpensego/contracts/platform/job-id";
import { Schema } from "effect";

/** Stable, non-sensitive identifiers shared by cross-package platform tests. */
export const platformFixtureIds = {
  correlationId: Schema.decodeUnknownSync(CorrelationId)("f3124c5a-82d1-45cf-924c-242e284afc6a"),
  jobId: Schema.decodeUnknownSync(JobId)("9ea2d859-c06e-43d7-8997-b842bc5f6e98"),
} as const;
