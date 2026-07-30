import { Schema } from "effect";

import { CorrelationId } from "./correlation-id.js";

const UtcTimestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
);

/** Runtime environments supported by the replacement platform. */
export const RuntimeEnvironment = Schema.Literal(
  "local",
  "development",
  "staging",
  "production",
  "test",
);

/** A parsed runtime environment. */
export type RuntimeEnvironment = typeof RuntimeEnvironment.Type;

/** Version 1 response returned by the platform status endpoint. */
export const PlatformStatusV1 = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literal("ready"),
  service: Schema.NonEmptyString,
  environment: RuntimeEnvironment,
  checkedAt: UtcTimestamp,
  correlationId: CorrelationId,
});

/** A parsed version 1 platform status response. */
export type PlatformStatusV1 = typeof PlatformStatusV1.Type;
