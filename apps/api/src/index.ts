import { layer as consoleRuntimeTelemetryLayer } from "@xpensego/adapters/cloudflare/console-runtime-telemetry";
import {
  InvalidRuntimeConfig,
  makeRuntimeConfigLayer,
} from "@xpensego/adapters/cloudflare/runtime-config";
import { makePostgresOutboxPersistenceLayer } from "@xpensego/adapters/postgres/outbox-store";
import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { OutboxJobV1 } from "@xpensego/contracts/platform/outbox-job";
import { PlatformStatusJobV1 } from "@xpensego/contracts/platform/platform-status-job";
import {
  dispatchPendingOutbox,
  recordOutboxConsumption,
} from "@xpensego/domain/outbox/outbox-delivery";
import { readPlatformStatus } from "@xpensego/domain/platform/read-platform-status";
import type { RuntimeConfig } from "@xpensego/domain/platform/runtime-config";
import { RuntimeTelemetry } from "@xpensego/domain/platform/runtime-telemetry";
import { Effect, Layer, Redacted, Schema } from "effect";

import { makeOutboxQueuePublicationLayer } from "./outbox-queue-publication.js";

const PlatformQueueJobV1 = Schema.Union(PlatformStatusJobV1, OutboxJobV1);

class InvalidCorrelationId extends Schema.TaggedError<InvalidCorrelationId>()(
  "InvalidCorrelationId",
  {
    correlationId: CorrelationId,
  },
) {
  /** Safe explanation that excludes the rejected header value. */
  override get message(): string {
    return "The request correlation identifier is invalid.";
  }
}

class InvalidPlatformQueueJob extends Schema.TaggedError<InvalidPlatformQueueJob>()(
  "InvalidPlatformQueueJob",
  {
    messageId: Schema.String,
  },
) {
  /** Safe explanation that excludes the rejected Queue body. */
  override get message(): string {
    return `Queue message ${this.messageId} is not a supported platform job.`;
  }
}

type ApiErrorCode =
  "invalid_correlation_id" | "invalid_runtime_configuration" | "internal_error" | "route_not_found";

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  correlationId: CorrelationId,
): Response {
  return jsonResponse(
    {
      version: 1,
      error: {
        code,
        message,
        correlationId,
      },
    },
    status,
  );
}

function generatedCorrelationId(): CorrelationId {
  return Schema.decodeUnknownSync(CorrelationId)(crypto.randomUUID());
}

const parseCorrelationId = Effect.fn("Api.parseCorrelationId")(function* (request: Request) {
  const fallback = generatedCorrelationId();
  const candidate = request.headers.get("x-correlation-id") ?? fallback;

  return yield* Schema.decodeUnknown(CorrelationId)(candidate).pipe(
    Effect.mapError(() => new InvalidCorrelationId({ correlationId: fallback })),
  );
});

function invocationLayer(
  env: CloudflareBindings,
): Layer.Layer<RuntimeConfig | RuntimeTelemetry, InvalidRuntimeConfig> {
  return Layer.merge(
    makeRuntimeConfigLayer({
      environment: env.ENVIRONMENT,
      serviceName: env.SERVICE_NAME,
    }),
    consoleRuntimeTelemetryLayer,
  );
}

function queueInvocationLayer(env: CloudflareBindings) {
  return Layer.merge(
    invocationLayer(env),
    makePostgresOutboxPersistenceLayer(Redacted.make(env.HYPERDRIVE.connectionString)),
  );
}

function scheduledInvocationLayer(env: CloudflareBindings) {
  return Layer.merge(
    queueInvocationLayer(env),
    makeOutboxQueuePublicationLayer(env.PLATFORM_JOBS_QUEUE),
  );
}

const handleFetch = Effect.fn("Api.fetch")(function* (request: Request) {
  const correlationId = yield* parseCorrelationId(request);
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/v1/platform/status") {
    const status = yield* readPlatformStatus({ correlationId });
    return jsonResponse(status, 200);
  }

  return errorResponse(
    404,
    "route_not_found",
    "The requested route does not exist.",
    correlationId,
  );
});

function runFetch(request: Request, env: CloudflareBindings): Promise<Response> {
  const program = handleFetch(request).pipe(
    Effect.provide(invocationLayer(env)),
    Effect.catchTag("InvalidCorrelationId", (error) =>
      Effect.succeed(
        errorResponse(
          400,
          "invalid_correlation_id",
          "The correlation identifier is invalid.",
          error.correlationId,
        ),
      ),
    ),
    Effect.catchTag("InvalidRuntimeConfig", () => {
      const correlationId = generatedCorrelationId();
      return Effect.succeed(
        errorResponse(
          500,
          "invalid_runtime_configuration",
          "The service is not configured correctly.",
          correlationId,
        ),
      );
    }),
    Effect.catchAllCause((cause) => {
      const correlationId = generatedCorrelationId();
      return Effect.sync(() => {
        // oxlint-disable-next-line no-console -- Cloudflare records structured console errors in Workers Logs.
        console.error(
          JSON.stringify({
            event: "UnhandledFetchFailure",
            correlationId,
            causeTag: cause._tag,
          }),
        );

        return errorResponse(
          500,
          "internal_error",
          "The service could not complete the request.",
          correlationId,
        );
      });
    }),
  );

  return Effect.runPromise(program);
}

const processQueueMessage = Effect.fn("Api.processQueueMessage")(function* (
  message: Message<unknown>,
) {
  const job = yield* Schema.decodeUnknown(PlatformQueueJobV1)(message.body, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => new InvalidPlatformQueueJob({ messageId: message.id })));

  if (job.kind === "platform.status.requested") {
    yield* readPlatformStatus({ correlationId: job.correlationId });
    const telemetry = yield* RuntimeTelemetry;
    yield* telemetry.emit({
      _tag: "PlatformStatusJobProcessed",
      correlationId: job.correlationId,
      jobId: job.jobId,
      outcome: "processed",
    });
    return;
  }

  yield* recordOutboxConsumption({
    outboxMessageId: job.outboxMessageId,
    correlationId: job.correlationId,
  });
});

function queueRetryDelaySeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.min(Math.max(attempts - 1, 0), 4), 300);
}

function processQueueMessageAtBoundary(message: Message<unknown>, queueName: string) {
  return processQueueMessage(message).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        message.ack();
      }),
    ),
    Effect.catchTag("InvalidPlatformQueueJob", (error) =>
      Effect.sync(() => {
        message.ack();
        // oxlint-disable-next-line no-console -- Invalid Queue envelopes are terminal and recorded without their body.
        console.error(
          JSON.stringify({
            event: "InvalidPlatformQueueJob",
            errorTag: error._tag,
            messageId: error.messageId,
            queue: queueName,
          }),
        );
      }),
    ),
    Effect.catchTag("OutboxPersistenceUnavailable", (error) =>
      Effect.sync(() => {
        message.retry({ delaySeconds: queueRetryDelaySeconds(message.attempts) });
        // oxlint-disable-next-line no-console -- Transient persistence failures are retried without Queue contents.
        console.error(
          JSON.stringify({
            event: "OutboxQueueJobDeferred",
            errorTag: error._tag,
            messageId: message.id,
            queue: queueName,
            attempts: message.attempts,
          }),
        );
      }),
    ),
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        message.retry({ delaySeconds: queueRetryDelaySeconds(message.attempts) });
        // oxlint-disable-next-line no-console -- Unexpected message failures retry only the affected Queue message.
        console.error(
          JSON.stringify({
            event: "UnhandledQueueMessageFailure",
            messageId: message.id,
            queue: queueName,
            attempts: message.attempts,
            causeTag: cause._tag,
          }),
        );
      }),
    ),
  );
}

function runQueue(batch: MessageBatch<unknown>, env: CloudflareBindings): Promise<void> {
  const program = Effect.forEach(
    batch.messages,
    (message) => processQueueMessageAtBoundary(message, batch.queue),
    {
      concurrency: 5,
      discard: true,
    },
  ).pipe(
    Effect.provide(queueInvocationLayer(env)),
    Effect.catchTag("InvalidRuntimeConfig", () =>
      Effect.sync(() => {
        batch.retryAll({ delaySeconds: 5 });
      }),
    ),
    Effect.catchTag("OutboxPersistenceUnavailable", () =>
      Effect.sync(() => {
        batch.retryAll({ delaySeconds: 5 });
      }),
    ),
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        batch.retryAll({ delaySeconds: 5 });
        // oxlint-disable-next-line no-console -- Unexpected Queue failures are retried and recorded safely.
        console.error(
          JSON.stringify({
            event: "UnhandledQueueFailure",
            queue: batch.queue,
            causeTag: cause._tag,
          }),
        );
      }),
    ),
  );

  return Effect.runPromise(program);
}

function runScheduled(env: CloudflareBindings): Promise<void> {
  const program = dispatchPendingOutbox().pipe(
    Effect.provide(scheduledInvocationLayer(env)),
    Effect.asVoid,
    Effect.catchAll((error) =>
      Effect.sync(() => {
        // oxlint-disable-next-line no-console -- Scheduled recovery logs only typed error tags.
        console.error(
          JSON.stringify({
            event: "OutboxDispatchDeferred",
            errorTag: error._tag,
          }),
        );
      }),
    ),
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        // oxlint-disable-next-line no-console -- Scheduled recovery logs no message or database contents.
        console.error(
          JSON.stringify({
            event: "UnhandledOutboxDispatchFailure",
            causeTag: cause._tag,
          }),
        );
      }),
    ),
  );

  return Effect.runPromise(program);
}

/** Cloudflare Worker entrypoints; each invocation executes exactly one Effect program. */
export default {
  fetch(request, env, _context) {
    return runFetch(request, env);
  },
  queue(batch, env, _context) {
    return runQueue(batch, env);
  },
  scheduled(_controller, env, _context) {
    return runScheduled(env);
  },
} satisfies ExportedHandler<CloudflareBindings>;
