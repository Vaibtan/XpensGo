import type { OutboxJobV1 } from "@xpensego/contracts/platform/outbox-job";
import {
  OutboxPublication,
  OutboxPublicationUnavailable,
} from "@xpensego/domain/outbox/outbox-delivery";
import { Effect, Layer } from "effect";

/**
 * Build Queue-backed outbox publication from the invocation's generated binding.
 *
 * @param queue - Environment-specific Cloudflare Queue producer binding.
 * @returns A Layer that publishes content-minimized outbox envelopes.
 */
export function makeOutboxQueuePublicationLayer(queue: CloudflareBindings["PLATFORM_JOBS_QUEUE"]) {
  return Layer.succeed(
    OutboxPublication,
    OutboxPublication.of({
      publish: Effect.fn("CloudflareOutboxPublication.publish")((input) => {
        const job: OutboxJobV1 = {
          version: 1,
          kind: "outbox.message.ready",
          outboxMessageId: input.outboxMessageId,
          correlationId: input.correlationId,
        };

        return Effect.tryPromise({
          try: () => queue.send(job, { contentType: "json" }),
          catch: () =>
            new OutboxPublicationUnavailable({
              operation: "publishOutboxMessage",
              outboxMessageId: input.outboxMessageId,
              reason: "queue_request_failed",
            }),
        }).pipe(
          Effect.timeoutFail({
            duration: "5 seconds",
            onTimeout: () =>
              new OutboxPublicationUnavailable({
                operation: "publishOutboxMessage",
                outboxMessageId: input.outboxMessageId,
                reason: "queue_timeout",
              }),
          }),
          Effect.asVoid,
        );
      }),
    }),
  );
}
