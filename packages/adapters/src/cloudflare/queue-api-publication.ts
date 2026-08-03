import { HttpClient, HttpClientRequest } from "@effect/platform";
import type { OutboxJobV1 } from "@xpensego/contracts/platform/outbox-job";
import {
  OutboxPublication,
  OutboxPublicationOutcomeUnknown,
  OutboxPublicationUnavailable,
  type OutboxPublicationService,
} from "@xpensego/domain/outbox/outbox-delivery";
import { Effect, Layer, Redacted, Schema } from "effect";

/** Cloudflare account identifier accepted by the Queue REST API. */
export const CloudflareAccountId = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{32}$/),
  Schema.brand("CloudflareAccountId"),
);

/** Cloudflare Queue identifier accepted by the Queue REST API. */
export const CloudflareQueueId = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{32}$/),
  Schema.brand("CloudflareQueueId"),
);

/** Parsed Cloudflare account identifier. */
export type CloudflareAccountId = typeof CloudflareAccountId.Type;

/** Parsed Cloudflare Queue identifier. */
export type CloudflareQueueId = typeof CloudflareQueueId.Type;

/** Configuration for privileged out-of-band Queue publication. */
export interface CloudflareQueueApiPublicationConfig {
  readonly accountId: CloudflareAccountId;
  readonly queueId: CloudflareQueueId;
  readonly apiToken: Redacted.Redacted<string>;
}

const CloudflareQueuePushResponse = Schema.Struct({ success: Schema.Literal(true) });

/** Construct Queue publication through Cloudflare's authenticated REST API. */
export function makeCloudflareQueueApiPublication(
  config: CloudflareQueueApiPublicationConfig,
): Effect.Effect<OutboxPublicationService, never, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;

    const publish: OutboxPublicationService["publish"] = Effect.fn(
      "CloudflareQueueApiPublication.publish",
    )(function* (input) {
      const job: OutboxJobV1 = {
        version: 1,
        kind: "outbox.message.ready",
        outboxMessageId: input.outboxMessageId,
        correlationId: input.correlationId,
      };
      const request = HttpClientRequest.post(
        `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/queues/${config.queueId}/messages`,
      ).pipe(
        HttpClientRequest.bearerToken(config.apiToken),
        HttpClientRequest.bodyUnsafeJson({ body: job, content_type: "json" }),
      );
      const unknownOutcome = () =>
        new OutboxPublicationOutcomeUnknown({
          operation: "publishOutboxMessage" as const,
          outboxMessageId: input.outboxMessageId,
          reason: "queue_timeout" as const,
        });

      const response = yield* httpClient
        .execute(request)
        .pipe(
          Effect.mapError(unknownOutcome),
          Effect.timeoutFail({ duration: "5 seconds", onTimeout: unknownOutcome }),
        );
      if (response.status < 200 || response.status >= 300) {
        return yield* new OutboxPublicationUnavailable({
          operation: "publishOutboxMessage",
          outboxMessageId: input.outboxMessageId,
          reason: "queue_request_failed",
        });
      }

      const payload = yield* response.json.pipe(Effect.mapError(unknownOutcome));
      const accepted = Schema.decodeUnknownEither(CloudflareQueuePushResponse)(payload);
      if (accepted._tag === "Left") {
        return yield* unknownOutcome();
      }
    });

    return OutboxPublication.of({ publish });
  });
}

/** Build the privileged Cloudflare Queue REST publication Layer. */
export function makeCloudflareQueueApiPublicationLayer(
  config: CloudflareQueueApiPublicationConfig,
) {
  return Layer.effect(OutboxPublication, makeCloudflareQueueApiPublication(config));
}
