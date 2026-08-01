import { makePostgresInboundEventStoreLayer } from "@xpensego/adapters/postgres/inbound-event-store";
import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import { acceptInboundEvent } from "@xpensego/domain/channel/accept-inbound-event";
import { ExternalChannelEventId } from "@xpensego/domain/channel/inbound-event";
import { UserId } from "@xpensego/domain/identity/user-id";
import { LedgerId } from "@xpensego/domain/ledger/ledger-id";
import { OutboxPublication } from "@xpensego/domain/outbox/outbox-delivery";
import { Effect, Either, Redacted, Schema } from "effect";

import { makeOutboxQueuePublicationLayer } from "./outbox-queue-publication.js";

const probePath = "/_internal/phase1-staging-proof";

const ProbeSecret = Schema.String.pipe(
  Schema.minLength(32),
  Schema.maxLength(256),
  Schema.brand("Phase1ProbeSecret"),
);

const BuildRevision = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{40}$/),
  Schema.brand("BuildRevision"),
);

const ProbeRunId = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9-]{1,80}$/),
  Schema.brand("Phase1ProbeRunId"),
);

const RedeliveryToken = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{64}$/),
  Schema.brand("Phase1RedeliveryToken"),
);

const AcceptInboundEventCommand = Schema.Struct({
  operation: Schema.Literal("acceptInboundEvent"),
  runId: ProbeRunId,
  ownerUserId: UserId,
  ledgerId: LedgerId,
  otherOwnerUserId: UserId,
});

const RedeliverOutboxCommand = Schema.Struct({
  operation: Schema.Literal("redeliverOutbox"),
  runId: ProbeRunId,
  outboxMessageId: OutboxMessageId,
  redeliveryToken: RedeliveryToken,
});

const ProbeCommand = Schema.Union(AcceptInboundEventCommand, RedeliverOutboxCommand);

const RawProbeConfig = Schema.Struct({
  authorizationSecret: ProbeSecret,
  signingSecret: ProbeSecret,
  buildRevision: BuildRevision,
});

interface ProbeConfig {
  readonly authorizationSecret: Redacted.Redacted<typeof ProbeSecret.Type>;
  readonly signingSecret: Redacted.Redacted<typeof ProbeSecret.Type>;
  readonly buildRevision: typeof BuildRevision.Type;
}

class InvalidPhase1ProbeCommand extends Schema.TaggedError<InvalidPhase1ProbeCommand>()(
  "InvalidPhase1ProbeCommand",
  {},
) {}

class Phase1ProbeInvariantViolation extends Schema.TaggedError<Phase1ProbeInvariantViolation>()(
  "Phase1ProbeInvariantViolation",
  {},
) {}

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function constantTimeEqual(actualValue: string, expectedValue: string): Promise<boolean> {
  const [actual, expected] = await Promise.all([digest(actualValue), digest(expectedValue)]);
  let difference = 0;

  for (let index = 0; index < expected.length; index += 1) {
    difference |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
  }

  return difference === 0;
}

async function hasValidAuthorization(
  request: Request,
  secret: Redacted.Redacted<typeof ProbeSecret.Type>,
): Promise<boolean> {
  const authorization = request.headers.get("authorization") ?? "";
  return constantTimeEqual(authorization, `Bearer ${Redacted.value(secret)}`);
}

async function signRedeliveryCapability(
  runId: typeof ProbeRunId.Type,
  outboxMessageId: OutboxMessageId,
  secret: Redacted.Redacted<typeof ProbeSecret.Type>,
): Promise<typeof RedeliveryToken.Type> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(Redacted.value(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${runId}:${outboxMessageId}`)),
  );
  const encoded = Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return Schema.decodeUnknownSync(RedeliveryToken)(encoded);
}

function decodeCommand(request: Request) {
  return Effect.tryPromise({
    try: () => request.json(),
    catch: () => new InvalidPhase1ProbeCommand(),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(ProbeCommand, { onExcessProperty: "error" })),
    Effect.mapError(() => new InvalidPhase1ProbeCommand()),
  );
}

function resolveProbeConfig(env: CloudflareBindings): ProbeConfig | undefined {
  const decoded = Schema.decodeUnknownEither(RawProbeConfig)({
    authorizationSecret: env.PHASE1_PROBE_SECRET,
    signingSecret: env.PHASE1_PROBE_SIGNING_SECRET,
    buildRevision: env.BUILD_REVISION,
  });

  if (Either.isLeft(decoded)) {
    return undefined;
  }
  if (decoded.right.authorizationSecret === decoded.right.signingSecret) {
    return undefined;
  }

  return {
    authorizationSecret: Redacted.make(decoded.right.authorizationSecret),
    signingSecret: Redacted.make(decoded.right.signingSecret),
    buildRevision: decoded.right.buildRevision,
  };
}

function makeCorrelationId(): CorrelationId {
  return Schema.decodeUnknownSync(CorrelationId)(crypto.randomUUID());
}

function acceptConcurrently(
  command: typeof AcceptInboundEventCommand.Type,
  databaseUrl: Redacted.Redacted<string>,
  config: ProbeConfig,
) {
  const common = {
    ownerUserId: command.ownerUserId,
    ledgerId: command.ledgerId,
    channel: "telegram" as const,
    externalEventId: Schema.decodeUnknownSync(ExternalChannelEventId)(
      `phase1-proof:${command.runId}:concurrent`,
    ),
  };
  const inboundLayer = makePostgresInboundEventStoreLayer(databaseUrl);

  return Effect.gen(function* () {
    const concurrentOutcomes = yield* Effect.all(
      [
        acceptInboundEvent({ ...common, correlationId: makeCorrelationId() }),
        acceptInboundEvent({ ...common, correlationId: makeCorrelationId() }),
      ],
      { concurrency: 2 },
    );
    const accepted = concurrentOutcomes.find((outcome) => outcome._tag === "Accepted");
    if (accepted?._tag !== "Accepted") {
      return yield* new Phase1ProbeInvariantViolation();
    }
    const crossOwnerOutcome = yield* acceptInboundEvent({
      ...common,
      ownerUserId: command.otherOwnerUserId,
      externalEventId: Schema.decodeUnknownSync(ExternalChannelEventId)(
        `phase1-proof:${command.runId}:cross-owner`,
      ),
      correlationId: makeCorrelationId(),
    }).pipe(
      Effect.match({
        onFailure: (error) => error._tag,
        onSuccess: (outcome) => outcome._tag,
      }),
    );
    const redeliveryToken = yield* Effect.promise(() =>
      signRedeliveryCapability(command.runId, accepted.outboxMessageId, config.signingSecret),
    );

    return {
      version: 1,
      operation: command.operation,
      buildRevision: config.buildRevision,
      concurrentOutcomes: concurrentOutcomes.map((outcome) => outcome._tag).sort(),
      acceptedOutboxMessageId: accepted.outboxMessageId,
      crossOwnerOutcome,
      redeliveryToken,
    } as const;
  }).pipe(Effect.provide(inboundLayer), Effect.scoped);
}

function redeliverOutbox(
  command: typeof RedeliverOutboxCommand.Type,
  queue: CloudflareBindings["PLATFORM_JOBS_QUEUE"],
  config: ProbeConfig,
) {
  return Effect.gen(function* () {
    const expectedToken = yield* Effect.promise(() =>
      signRedeliveryCapability(command.runId, command.outboxMessageId, config.signingSecret),
    );
    const validCapability = yield* Effect.promise(() =>
      constantTimeEqual(command.redeliveryToken, expectedToken),
    );
    if (!validCapability) {
      return yield* new InvalidPhase1ProbeCommand();
    }

    const publication = yield* OutboxPublication;
    yield* publication.publish({
      outboxMessageId: command.outboxMessageId,
      correlationId: makeCorrelationId(),
    });
    return {
      version: 1,
      operation: command.operation,
      buildRevision: config.buildRevision,
      outcome: "published" as const,
    };
  }).pipe(Effect.provide(makeOutboxQueuePublicationLayer(queue)));
}

/**
 * Run a secret-protected staging acceptance command against real managed bindings.
 * Non-staging environments and failed authorization remain indistinguishable from a missing route.
 */
export async function handlePhase1StagingProbe(
  request: Request,
  env: CloudflareBindings,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== probePath || env.ENVIRONMENT !== "staging") {
    return undefined;
  }

  const config = resolveProbeConfig(env);
  if (config === undefined || !(await hasValidAuthorization(request, config.authorizationSecret))) {
    return undefined;
  }
  if (request.method !== "POST") {
    return response({ version: 1, error: { code: "method_not_allowed" } }, 405);
  }

  const program = Effect.gen(function* () {
    const command = yield* decodeCommand(request);
    const databaseUrl = Redacted.make(env.HYPERDRIVE.connectionString);

    switch (command.operation) {
      case "acceptInboundEvent":
        return yield* acceptConcurrently(command, databaseUrl, config);
      case "redeliverOutbox":
        return yield* redeliverOutbox(command, env.PLATFORM_JOBS_QUEUE, config);
    }
  }).pipe(
    Effect.match({
      onFailure: (error) =>
        error instanceof InvalidPhase1ProbeCommand
          ? response({ version: 1, error: { code: "invalid_probe_command" } }, 400)
          : response({ version: 1, error: { code: "probe_unavailable" } }, 503),
      onSuccess: (result) => response(result),
    }),
  );

  return Effect.runPromise(program);
}
