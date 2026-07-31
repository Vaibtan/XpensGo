import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { OutboxJobV1 } from "./outbox-job.js";

describe("OutboxJobV1", () => {
  it("decodes a content-minimized outbox Queue envelope", () => {
    const decoded = Schema.decodeUnknownSync(OutboxJobV1)(
      {
        version: 1,
        kind: "outbox.message.ready",
        outboxMessageId: "98b2ea19-c24e-49a3-a808-f39667b3c32e",
        correlationId: "0a07b859-8572-4f11-bc54-36ee65c96ac5",
      },
      { onExcessProperty: "error" },
    );

    expect(decoded.kind).toBe("outbox.message.ready");
  });

  it("rejects financial contents and unsupported fields", () => {
    expect(() =>
      Schema.decodeUnknownSync(OutboxJobV1)(
        {
          version: 1,
          kind: "outbox.message.ready",
          outboxMessageId: "98b2ea19-c24e-49a3-a808-f39667b3c32e",
          correlationId: "0a07b859-8572-4f11-bc54-36ee65c96ac5",
          messageText: "Paid 500 to a counterparty",
        },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });
});
