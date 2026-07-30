import type { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import type { PlatformStatusV1 } from "@xpensego/contracts/platform/platform-status";
import { Clock, Effect } from "effect";

import { RuntimeConfig } from "./runtime-config.js";
import { RuntimeTelemetry } from "./runtime-telemetry.js";

type ReadPlatformStatusInput = {
  readonly correlationId: CorrelationId;
};

/**
 * Read the replacement platform's minimal status through its application seam.
 *
 * @param input - Parsed invocation context for the status request.
 * @returns The versioned status response after safe telemetry is recorded.
 */
export const readPlatformStatus = Effect.fn("Platform.readStatus")(function* (
  input: ReadPlatformStatusInput,
) {
  const config = yield* RuntimeConfig;
  const telemetry = yield* RuntimeTelemetry;
  const currentTimeMillis = yield* Clock.currentTimeMillis;

  const status = {
    version: 1,
    status: "ready",
    service: config.serviceName,
    environment: config.environment,
    checkedAt: new Date(currentTimeMillis).toISOString(),
    correlationId: input.correlationId,
  } satisfies PlatformStatusV1;

  yield* telemetry.emit({
    _tag: "PlatformStatusRead",
    correlationId: input.correlationId,
    outcome: "ready",
  });

  return status;
});
