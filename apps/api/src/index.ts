import { layer as consoleRuntimeTelemetryLayer } from "@xpensego/adapters/cloudflare/console-runtime-telemetry";
import {
  type BetterAuthRuntimeConfig,
  BetterAuthUnavailable,
  handleBetterAuthRequest,
} from "@xpensego/adapters/auth/better-auth";
import {
  InvalidRuntimeConfig,
  makeRuntimeConfigLayer,
} from "@xpensego/adapters/cloudflare/runtime-config";
import { makePostgresOutboxPersistenceLayer } from "@xpensego/adapters/postgres/outbox-store";
import { makePostgresIdentityStoreLayer } from "@xpensego/adapters/postgres/identity-store";
import { makePostgresTelegramIngressStoreLayer } from "@xpensego/adapters/postgres/telegram-ingress-store";
import { makePostgresTelegramQueueRuntimeLayer } from "@xpensego/adapters/postgres/telegram-queue-runtime";
import { makeTelegramBotApiLayer } from "@xpensego/adapters/telegram/bot-api";
import { webCryptoLinkChallengeLayer } from "@xpensego/adapters/web-crypto/link-challenge-crypto";
import {
  OutboxJobV1,
  type OutboxJobV1 as OutboxQueueJob,
} from "@xpensego/contracts/platform/outbox-job";
import {
  PlatformStatusJobV1,
  type PlatformStatusJobV1 as PlatformStatusQueueJob,
} from "@xpensego/contracts/platform/platform-status-job";
import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import type { PlatformInternalError } from "@xpensego/contracts/platform/platform-api";
import {
  dispatchPendingOutbox,
  recordOutboxConsumption,
} from "@xpensego/domain/outbox/outbox-delivery";
import { acceptTelegramEvent } from "@xpensego/domain/channel/accept-telegram-event";
import { deliverTelegramReply } from "@xpensego/domain/channel/deliver-telegram-reply";
import { processTelegramEvent } from "@xpensego/domain/channel/process-telegram-event";
import { readPlatformStatus } from "@xpensego/domain/platform/read-platform-status";
import type { RuntimeConfig } from "@xpensego/domain/platform/runtime-config";
import { RuntimeTelemetry } from "@xpensego/domain/platform/runtime-telemetry";
import { Effect, Layer, Redacted, Schema } from "effect";

import { handleApplicationRequest, handleIdentityRequest } from "./http.js";
import { makeOutboxQueuePublicationLayer } from "./outbox-queue-publication.js";
import { handlePhase1StagingProbe } from "./phase1-staging-probe.js";
import { verifyAndDecodeTelegramWebhook } from "./telegram-webhook.js";

const PlatformQueueJobV1 = Schema.Union(PlatformStatusJobV1, OutboxJobV1);
const TelegramWebhookSecret = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(256),
  Schema.pattern(/^[A-Za-z0-9_-]+$/),
);
const telegramWebhookMaximumBodyBytes = 64 * 1_024;

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

function betterAuthRuntimeConfig(env: CloudflareBindings): BetterAuthRuntimeConfig {
  return {
    baseUrl: env.PUBLIC_WEB_ORIGIN,
    databaseUrl: Redacted.make(env.HYPERDRIVE.connectionString),
    secret: Redacted.make(env.BETTER_AUTH_SECRET ?? ""),
    trustedOrigin: env.PUBLIC_WEB_ORIGIN,
    useSecureCookies: env.PUBLIC_WEB_ORIGIN.startsWith("https://"),
  };
}

function identityInvocationLayer(env: CloudflareBindings) {
  return Layer.merge(
    makePostgresIdentityStoreLayer(Redacted.make(env.HYPERDRIVE.connectionString)),
    webCryptoLinkChallengeLayer,
  );
}

function telegramIngressInvocationLayer(env: CloudflareBindings) {
  return Layer.merge(
    makePostgresTelegramIngressStoreLayer(Redacted.make(env.HYPERDRIVE.connectionString)),
    webCryptoLinkChallengeLayer,
  );
}

function queueInvocationLayer(env: CloudflareBindings) {
  return Layer.merge(
    invocationLayer(env),
    makePostgresOutboxPersistenceLayer(Redacted.make(env.HYPERDRIVE.connectionString)),
  );
}

function outboxQueueInvocationLayer(env: CloudflareBindings) {
  const databaseUrl = Redacted.make(env.HYPERDRIVE.connectionString);
  return Layer.mergeAll(
    consoleRuntimeTelemetryLayer,
    makePostgresTelegramQueueRuntimeLayer(databaseUrl),
    makeTelegramBotApiLayer({
      botToken: Redacted.make(env.TELEGRAM_BOT_TOKEN ?? ""),
      publicWebOrigin: env.PUBLIC_WEB_ORIGIN,
    }),
  );
}

function scheduledInvocationLayer(env: CloudflareBindings) {
  return Layer.merge(
    queueInvocationLayer(env),
    makeOutboxQueuePublicationLayer(env.PLATFORM_JOBS_QUEUE),
  );
}

function telegramWebhookResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function runTelegramWebhookFetch(
  request: Request,
  env: CloudflareBindings,
  context: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { allow: "POST", "cache-control": "no-store" },
    });
  }

  const configuredSecret = Schema.decodeUnknownEither(TelegramWebhookSecret)(
    env.TELEGRAM_WEBHOOK_SECRET,
  );
  if (configuredSecret._tag === "Left") {
    return telegramWebhookResponse({ ok: false, error: "unavailable" }, 503);
  }

  const decoded = await Effect.runPromise(
    verifyAndDecodeTelegramWebhook(request, {
      webhookSecret: Redacted.make(configuredSecret.right),
      maximumBodyBytes: telegramWebhookMaximumBodyBytes,
    }).pipe(Effect.either),
  );
  if (decoded._tag === "Left") {
    const error = decoded.left;
    switch (error._tag) {
      case "TelegramWebhookUnsupported":
        // oxlint-disable-next-line no-console -- Only a safe rejection reason is logged.
        console.log(JSON.stringify({ event: "TelegramWebhookIgnored", reason: error.reason }));
        return telegramWebhookResponse({ ok: true, status: "ignored" }, 200);
      case "TelegramWebhookUnauthorized":
        return telegramWebhookResponse({ ok: false, error: "unauthorized" }, 401);
      case "TelegramWebhookBodyTooLarge":
        return telegramWebhookResponse({ ok: false, error: "body_too_large" }, 413);
      case "TelegramWebhookMalformed":
        return telegramWebhookResponse({ ok: false, error: "malformed_update" }, 400);
      case "TelegramWebhookUnavailable":
        return telegramWebhookResponse({ ok: false, error: "unavailable" }, 503);
    }
  }

  const correlationId = Schema.decodeUnknownSync(CorrelationId)(crypto.randomUUID());
  const accepted = await Effect.runPromise(
    acceptTelegramEvent({ update: decoded.right, correlationId }).pipe(
      Effect.provide(telegramIngressInvocationLayer(env)),
      Effect.either,
    ),
  );
  if (accepted._tag === "Left") {
    return telegramWebhookResponse({ ok: false, error: "unavailable" }, 503);
  }

  context.waitUntil(runScheduled(env));
  return telegramWebhookResponse(
    {
      ok: true,
      status: accepted.right._tag === "Accepted" ? "accepted" : "duplicate",
    },
    200,
  );
}

async function runFetch(
  request: Request,
  env: CloudflareBindings,
  context: ExecutionContext,
): Promise<Response> {
  const probeResponse = await handlePhase1StagingProbe(request, env);
  if (probeResponse !== undefined) {
    return probeResponse;
  }

  if (new URL(request.url).pathname.startsWith("/v1/auth/")) {
    return runAuthenticationFetch(request, env);
  }

  if (new URL(request.url).pathname === "/v1/channels/telegram/webhook") {
    return runTelegramWebhookFetch(request, env, context);
  }

  const applicationPath = new URL(request.url).pathname;
  const isIdentityRequest =
    applicationPath === "/v1/identity" || applicationPath.startsWith("/v1/identity/");
  const applicationResponse = isIdentityRequest
    ? handleIdentityRequest(
        request,
        identityInvocationLayer(env),
        betterAuthRuntimeConfig(env),
        env.TELEGRAM_BOT_USERNAME,
      )
    : handleApplicationRequest(request, invocationLayer(env));

  return applicationResponse.catch((cause: unknown) => {
    const correlationId = Schema.decodeUnknownSync(CorrelationId)(crypto.randomUUID());
    // oxlint-disable-next-line no-console -- Cloudflare records structured console errors in Workers Logs.
    console.error(
      JSON.stringify({
        event: "UnhandledFetchFailure",
        correlationId,
        causeTag: cause instanceof Error ? cause.name : "UnknownDefect",
      }),
    );
    const responseBody: PlatformInternalError = {
      version: 1,
      error: {
        code: "internal_error",
        message: "The service could not complete the request.",
        correlationId,
      },
    };
    return Response.json(responseBody, {
      status: 500,
      headers: { "cache-control": "no-store" },
    });
  });
}

function runAuthenticationFetch(request: Request, env: CloudflareBindings): Promise<Response> {
  const program = handleBetterAuthRequest(betterAuthRuntimeConfig(env), request).pipe(
    Effect.map((response) => {
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }),
    Effect.catchAll((error) =>
      Effect.succeed(
        Response.json(
          {
            version: 1,
            error: {
              code:
                error instanceof BetterAuthUnavailable
                  ? "authentication_unavailable"
                  : "invalid_authentication_config",
              message: "Authentication is temporarily unavailable.",
              correlationId: crypto.randomUUID(),
            },
          },
          { status: 503, headers: { "cache-control": "no-store" } },
        ),
      ),
    ),
  );

  return Effect.runPromise(program);
}

const decodeQueueMessage = Effect.fn("Api.decodeQueueMessage")(function* (
  message: Message<unknown>,
) {
  return yield* Schema.decodeUnknown(PlatformQueueJobV1)(message.body, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => new InvalidPlatformQueueJob({ messageId: message.id })));
});

const processPlatformStatusJob = Effect.fn("Api.processPlatformStatusJob")(function* (
  job: PlatformStatusQueueJob,
) {
  yield* readPlatformStatus({ correlationId: job.correlationId });
  const telemetry = yield* RuntimeTelemetry;
  yield* telemetry.emit({
    _tag: "PlatformStatusJobProcessed",
    correlationId: job.correlationId,
    jobId: job.jobId,
    outcome: "processed",
  });
});

const processOutboxJob = Effect.fn("Api.processOutboxJob")(function* (job: OutboxQueueJob) {
  const eventOutcome = yield* processTelegramEvent({
    outboxMessageId: job.outboxMessageId,
    correlationId: job.correlationId,
  });
  if (eventOutcome._tag === "NotFound") {
    yield* deliverTelegramReply({ outboxMessageId: job.outboxMessageId });
  }
  yield* recordOutboxConsumption({
    outboxMessageId: job.outboxMessageId,
    correlationId: job.correlationId,
  });
});

function queueRetryDelaySeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.min(Math.max(attempts - 1, 0), 4), 300);
}

function decodeQueueMessageAtBoundary(message: Message<unknown>, queueName: string) {
  return decodeQueueMessage(message).pipe(
    Effect.map((job) => ({ message, job })),
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
        return null;
      }),
    ),
  );
}

function processPlatformStatusMessageAtBoundary(
  message: Message<unknown>,
  queueName: string,
  job: PlatformStatusQueueJob,
) {
  return processPlatformStatusJob(job).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        message.ack();
      }),
    ),
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        message.ack();
        // oxlint-disable-next-line no-console -- Unclassified defects are terminal until code is reviewed.
        console.error(
          JSON.stringify({
            event: "TerminalQueueMessageDefect",
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

function processOutboxMessageAtBoundary(
  message: Message<unknown>,
  queueName: string,
  job: OutboxQueueJob,
) {
  const retry = (errorTag: string, retryAfterSeconds?: number) =>
    Effect.sync(() => {
      message.retry({
        delaySeconds: retryAfterSeconds ?? queueRetryDelaySeconds(message.attempts),
      });
      // oxlint-disable-next-line no-console -- Retry logs exclude Queue and provider contents.
      console.error(
        JSON.stringify({
          event: "OutboxQueueJobDeferred",
          errorTag,
          messageId: message.id,
          queue: queueName,
          attempts: message.attempts,
        }),
      );
    });

  return processOutboxJob(job).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        message.ack();
      }),
    ),
    Effect.catchTags({
      OutboxPersistenceUnavailable: (error) => retry(error._tag),
      TelegramDeliveryPersistenceUnavailable: (error) => retry(error._tag),
      TelegramEventProcessingDeferred: (error) => retry(error._tag, error.retryAfterSeconds),
      TelegramEventProcessingPersistenceUnavailable: (error) => retry(error._tag),
      TelegramIdentityResolutionUnavailable: (error) => retry(error._tag),
      TelegramReplyDeliveryDeferred: (error) => retry(error._tag, error.retryAfterSeconds),
    }),
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        message.ack();
        // oxlint-disable-next-line no-console -- Durable outbox recovery replaces blind defect retries.
        console.error(
          JSON.stringify({
            event: "TerminalQueueMessageDefect",
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

interface QueueMessageWithJob<Job> {
  readonly message: Message<unknown>;
  readonly job: Job;
}

function retryQueueMessagesAfterLayerFailure(
  messages: ReadonlyArray<QueueMessageWithJob<unknown>>,
  queueName: string,
  event: "OutboxQueueJobDeferred" | "PlatformStatusQueueJobDeferred",
  errorTag: string,
) {
  return Effect.sync(() => {
    for (const { message } of messages) {
      message.retry({ delaySeconds: queueRetryDelaySeconds(message.attempts) });
      // oxlint-disable-next-line no-console -- Layer failures are logged without Queue contents or provider details.
      console.error(
        JSON.stringify({
          event,
          errorTag,
          messageId: message.id,
          queue: queueName,
          attempts: message.attempts,
        }),
      );
    }
  });
}

function runQueue(batch: MessageBatch<unknown>, env: CloudflareBindings): Promise<void> {
  const program = Effect.gen(function* () {
    const decodedMessages = yield* Effect.forEach(
      batch.messages,
      (message) => decodeQueueMessageAtBoundary(message, batch.queue),
      { concurrency: 5 },
    );
    const platformStatusMessages: Array<QueueMessageWithJob<PlatformStatusQueueJob>> = [];
    const outboxMessages: Array<QueueMessageWithJob<OutboxQueueJob>> = [];

    for (const decodedMessage of decodedMessages) {
      if (decodedMessage === null) {
        continue;
      }

      if (decodedMessage.job.kind === "platform.status.requested") {
        platformStatusMessages.push({
          message: decodedMessage.message,
          job: decodedMessage.job,
        });
      } else {
        outboxMessages.push({
          message: decodedMessage.message,
          job: decodedMessage.job,
        });
      }
    }

    if (platformStatusMessages.length > 0) {
      yield* Effect.forEach(
        platformStatusMessages,
        ({ message, job }) => processPlatformStatusMessageAtBoundary(message, batch.queue, job),
        { concurrency: 5, discard: true },
      ).pipe(
        Effect.provide(invocationLayer(env)),
        Effect.catchTag("InvalidRuntimeConfig", (error) =>
          retryQueueMessagesAfterLayerFailure(
            platformStatusMessages,
            batch.queue,
            "PlatformStatusQueueJobDeferred",
            error._tag,
          ),
        ),
      );
    }

    if (outboxMessages.length > 0) {
      yield* Effect.forEach(
        outboxMessages,
        ({ message, job }) => processOutboxMessageAtBoundary(message, batch.queue, job),
        { concurrency: 5, discard: true },
      ).pipe(
        Effect.provide(outboxQueueInvocationLayer(env)),
        Effect.catchTag("OutboxPersistenceUnavailable", (error) =>
          retryQueueMessagesAfterLayerFailure(
            outboxMessages,
            batch.queue,
            "OutboxQueueJobDeferred",
            error._tag,
          ),
        ),
      );
    }
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        batch.ackAll();
        // oxlint-disable-next-line no-console -- Unclassified batch defects require code review, not re-execution.
        console.error(
          JSON.stringify({
            event: "TerminalQueueBatchDefect",
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
  fetch(request, env, context) {
    return runFetch(request, env, context);
  },
  queue(batch, env, _context) {
    return runQueue(batch, env);
  },
  scheduled(_controller, env, _context) {
    return runScheduled(env);
  },
} satisfies ExportedHandler<CloudflareBindings>;
