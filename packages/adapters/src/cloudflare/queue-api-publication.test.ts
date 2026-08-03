import { HttpClient, HttpClientError, HttpClientResponse } from "@effect/platform";
import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import {
  OutboxPublication,
  OutboxPublicationOutcomeUnknown,
  OutboxPublicationUnavailable,
} from "@xpensego/domain/outbox/outbox-delivery";
import { Effect, Layer, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CloudflareAccountId,
  CloudflareQueueId,
  makeCloudflareQueueApiPublicationLayer,
} from "./queue-api-publication.js";

const publication = {
  outboxMessageId: Schema.decodeUnknownSync(OutboxMessageId)(
    "98b2ea19-c24e-49a3-a808-f39667b3c32e",
  ),
  correlationId: Schema.decodeUnknownSync(CorrelationId)("0a07b859-8572-4f11-bc54-36ee65c96ac5"),
} as const;
const accountId = Schema.decodeUnknownSync(CloudflareAccountId)("8f74ed3dc133e7662ff6889883764bc0");
const queueId = Schema.decodeUnknownSync(CloudflareQueueId)("27a57f577c5f4263addcf0b514b9fbdd");

function publishWith(execute: Parameters<typeof HttpClient.make>[0]) {
  const clientLayer = Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute));
  return Effect.gen(function* () {
    const publicationService = yield* OutboxPublication;
    return yield* publicationService.publish(publication);
  }).pipe(
    Effect.provide(
      makeCloudflareQueueApiPublicationLayer({
        accountId,
        queueId,
        apiToken: Redacted.make("queue-api-token-for-tests"),
      }).pipe(Layer.provide(clientLayer)),
    ),
  );
}

describe("Cloudflare Queue API publication", () => {
  it("pushes the versioned outbox job as JSON", async () => {
    const requests: Array<Parameters<Parameters<typeof HttpClient.make>[0]>[0]> = [];

    await Effect.runPromise(
      publishWith((request) =>
        Effect.sync(() => {
          requests.push(request);
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              success: true,
              result: { metadata: { metrics: { backlog_count: 1, backlog_bytes: 100 } } },
            }),
          );
        }),
      ),
    );

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/8f74ed3dc133e7662ff6889883764bc0/queues/27a57f577c5f4263addcf0b514b9fbdd/messages",
    );
    expect(request?.method).toBe("POST");
    expect(request?.headers.authorization).toBe("Bearer queue-api-token-for-tests");
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.body._tag).toBe("Uint8Array");
    if (request?.body._tag !== "Uint8Array") {
      return;
    }
    expect(JSON.parse(new TextDecoder().decode(request.body.body))).toEqual({
      body: {
        version: 1,
        kind: "outbox.message.ready",
        ...publication,
      },
      content_type: "json",
    });
  });

  it("classifies an explicit API rejection as unavailable", async () => {
    const error = await Effect.runPromise(
      publishWith((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ success: false }, { status: 403 })),
        ),
      ).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(OutboxPublicationUnavailable);
  });

  it("classifies network and malformed success outcomes as unknown", async () => {
    const networkError = await Effect.runPromise(
      publishWith((request) =>
        Effect.fail(
          new HttpClientError.RequestError({
            request,
            reason: "Transport",
            cause: new TypeError("connection closed"),
          }),
        ),
      ).pipe(Effect.flip),
    );
    const invalidError = await Effect.runPromise(
      publishWith((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ success: false }))),
      ).pipe(Effect.flip),
    );

    expect(networkError).toBeInstanceOf(OutboxPublicationOutcomeUnknown);
    expect(invalidError).toBeInstanceOf(OutboxPublicationOutcomeUnknown);
  });
});
