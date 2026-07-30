import { layer as consoleRuntimeTelemetryLayer } from "@xpensego/adapters/cloudflare/console-runtime-telemetry";
import {
  InvalidRuntimeConfig,
  makeRuntimeConfigLayer,
} from "@xpensego/adapters/cloudflare/runtime-config";
import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { PlatformStatusJobV1 } from "@xpensego/contracts/platform/platform-status-job";
import { readPlatformStatus } from "@xpensego/domain/platform/read-platform-status";
import type { RuntimeConfig } from "@xpensego/domain/platform/runtime-config";
import { RuntimeTelemetry } from "@xpensego/domain/platform/runtime-telemetry";
import { Effect, Either, Layer, Schema } from "effect";

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

class InvalidPlatformStatusJob extends Schema.TaggedError<InvalidPlatformStatusJob>()(
  "InvalidPlatformStatusJob",
  {
    messageId: Schema.String,
  },
) {
  /** Safe explanation that excludes the rejected Queue body. */
  override get message(): string {
    return `Queue message ${this.messageId} is not a supported platform status job.`;
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
  const decoded = yield* Schema.decodeUnknown(PlatformStatusJobV1)(message.body, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(() => new InvalidPlatformStatusJob({ messageId: message.id })),
    Effect.either,
  );

  if (Either.isLeft(decoded)) {
    yield* Effect.sync(() => {
      message.ack();
      // oxlint-disable-next-line no-console -- Invalid Queue envelopes are terminal and recorded without their body.
      console.error(
        JSON.stringify({
          event: "InvalidPlatformStatusJob",
          errorTag: decoded.left._tag,
          messageId: decoded.left.messageId,
        }),
      );
    });
    return;
  }

  yield* readPlatformStatus({ correlationId: decoded.right.correlationId });
  const telemetry = yield* RuntimeTelemetry;
  yield* telemetry.emit({
    _tag: "PlatformStatusJobProcessed",
    correlationId: decoded.right.correlationId,
    jobId: decoded.right.jobId,
    outcome: "processed",
  });
  yield* Effect.sync(() => {
    message.ack();
  });
});

function runQueue(batch: MessageBatch<unknown>, env: CloudflareBindings): Promise<void> {
  const program = Effect.forEach(batch.messages, processQueueMessage, {
    concurrency: 5,
    discard: true,
  }).pipe(
    Effect.provide(invocationLayer(env)),
    Effect.catchTag("InvalidRuntimeConfig", () =>
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

/** Cloudflare Worker entrypoints; each invocation executes exactly one Effect program. */
export default {
  fetch(request, env, _context) {
    return runFetch(request, env);
  },
  queue(batch, env, _context) {
    return runQueue(batch, env);
  },
} satisfies ExportedHandler<CloudflareBindings>;
