import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import { OutboxPublication } from "@xpensego/domain/outbox/outbox-delivery";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeOutboxQueuePublicationLayer } from "./outbox-queue-publication.js";

const publication = {
  outboxMessageId: Schema.decodeUnknownSync(OutboxMessageId)(
    "98b2ea19-c24e-49a3-a808-f39667b3c32e",
  ),
  correlationId: Schema.decodeUnknownSync(CorrelationId)("0a07b859-8572-4f11-bc54-36ee65c96ac5"),
} as const;

class TestQueue implements Queue<unknown> {
  readonly messages: Array<unknown> = [];

  constructor(private readonly neverSettles = false) {}

  metrics(): Promise<QueueMetrics> {
    return Promise.resolve({ backlogCount: this.messages.length, backlogBytes: 0 });
  }

  send(message: unknown, _options?: QueueSendOptions): Promise<QueueSendResponse> {
    if (this.neverSettles) {
      return new Promise<QueueSendResponse>(() => undefined);
    }

    this.messages.push(message);
    return Promise.resolve({
      metadata: { metrics: { backlogCount: this.messages.length, backlogBytes: 0 } },
    });
  }

  async sendBatch(
    messages: Iterable<MessageSendRequest<unknown>>,
    _options?: QueueSendBatchOptions,
  ): Promise<QueueSendBatchResponse> {
    for (const message of messages) {
      await this.send(message.body);
    }

    return {
      metadata: { metrics: { backlogCount: this.messages.length, backlogBytes: 0 } },
    };
  }
}

function publishWith(queue: Queue<unknown>) {
  return Effect.gen(function* () {
    const service = yield* OutboxPublication;
    return yield* service.publish(publication);
  }).pipe(Effect.provide(makeOutboxQueuePublicationLayer(queue)));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Cloudflare outbox Queue publication", () => {
  it("projects application identifiers to the versioned Queue protocol", async () => {
    const queue = new TestQueue();

    await Effect.runPromise(publishWith(queue));

    expect(queue.messages).toEqual([
      {
        version: 1,
        kind: "outbox.message.ready",
        ...publication,
      },
    ]);
  });

  it("classifies a non-settling Queue send as an unknown publication outcome", async () => {
    vi.useFakeTimers();
    const resultPromise = Effect.runPromise(publishWith(new TestQueue(true)).pipe(Effect.either));

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await resultPromise;

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "OutboxPublicationOutcomeUnknown",
        reason: "queue_timeout",
      });
    }
  });
});
