import { platformFixtureIds } from "@xpensego/testing/platform/platform-fixtures";
import { Effect, Layer, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { readPlatformStatus } from "./read-platform-status.js";
import { RuntimeConfig } from "./runtime-config.js";
import { RuntimeTelemetry } from "./runtime-telemetry.js";

const dependencies = Layer.mergeAll(
  Layer.succeed(
    RuntimeConfig,
    RuntimeConfig.of({
      environment: "test",
      serviceName: "xpensego-api",
    }),
  ),
  Layer.succeed(
    RuntimeTelemetry,
    RuntimeTelemetry.of({
      emit: () => Effect.void,
    }),
  ),
  TestContext.TestContext,
);

describe("readPlatformStatus", () => {
  it("returns a deterministic versioned status through the application interface", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(new Date("2026-07-31T00:00:00.000Z"));
        return yield* readPlatformStatus({ correlationId: platformFixtureIds.correlationId });
      }).pipe(Effect.provide(dependencies)),
    );

    expect(result).toEqual({
      version: 1,
      status: "ready",
      service: "xpensego-api",
      environment: "test",
      checkedAt: "2026-07-31T00:00:00.000Z",
      correlationId: platformFixtureIds.correlationId,
    });
  });
});
