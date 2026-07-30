import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { PlatformStatusV1 } from "./platform-status.js";

describe("PlatformStatusV1", () => {
  it("decodes the versioned public response", () => {
    const decoded = Schema.decodeUnknownSync(PlatformStatusV1)(
      {
        version: 1,
        status: "ready",
        service: "xpensego-api",
        environment: "test",
        checkedAt: "2026-07-31T00:00:00.000Z",
        correlationId: "f3124c5a-82d1-45cf-924c-242e284afc6a",
      },
      { onExcessProperty: "error" },
    );

    expect(decoded).toEqual({
      version: 1,
      status: "ready",
      service: "xpensego-api",
      environment: "test",
      checkedAt: "2026-07-31T00:00:00.000Z",
      correlationId: "f3124c5a-82d1-45cf-924c-242e284afc6a",
    });
  });

  it("rejects unknown fields on the internal contract", () => {
    expect(() =>
      Schema.decodeUnknownSync(PlatformStatusV1)(
        {
          version: 1,
          status: "ready",
          service: "xpensego-api",
          environment: "test",
          checkedAt: "2026-07-31T00:00:00.000Z",
          correlationId: "f3124c5a-82d1-45cf-924c-242e284afc6a",
          financialContents: "must not cross this boundary",
        },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });
});
