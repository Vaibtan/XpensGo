import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { PlatformStatusJobV1 } from "./platform-status-job.js";

describe("PlatformStatusJobV1", () => {
  it("decodes a versioned queue message containing identifiers only", () => {
    const decoded = Schema.decodeUnknownSync(PlatformStatusJobV1)(
      {
        version: 1,
        kind: "platform.status.requested",
        jobId: "9ea2d859-c06e-43d7-8997-b842bc5f6e98",
        correlationId: "f3124c5a-82d1-45cf-924c-242e284afc6a",
      },
      { onExcessProperty: "error" },
    );

    expect(decoded.kind).toBe("platform.status.requested");
  });

  it("rejects unsupported asynchronous contract versions", () => {
    expect(() =>
      Schema.decodeUnknownSync(PlatformStatusJobV1)(
        {
          version: 2,
          kind: "platform.status.requested",
          jobId: "9ea2d859-c06e-43d7-8997-b842bc5f6e98",
          correlationId: "f3124c5a-82d1-45cf-924c-242e284afc6a",
        },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });
});
