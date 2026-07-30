import { RuntimeConfig } from "@xpensego/domain/platform/runtime-config";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeRuntimeConfigLayer } from "./runtime-config.js";

describe("makeRuntimeConfigLayer", () => {
  it("parses runtime bindings", async () => {
    const config = await Effect.runPromise(
      RuntimeConfig.pipe(
        Effect.provide(
          makeRuntimeConfigLayer({
            environment: "test",
            serviceName: "xpensego-api",
          }),
        ),
      ),
    );

    expect(config.environment).toBe("test");
    expect(config.serviceName).toBe("xpensego-api");
  });

  it("returns a safe typed error for invalid bindings", async () => {
    const error = await Effect.runPromise(
      RuntimeConfig.pipe(
        Effect.provide(
          makeRuntimeConfigLayer({
            environment: "unknown",
            serviceName: "",
          }),
        ),
        Effect.flip,
      ),
    );

    expect(error._tag).toBe("InvalidRuntimeConfig");
    expect(error.message).toBe("Invalid runtime configuration: ENVIRONMENT, SERVICE_NAME");
  });
});
