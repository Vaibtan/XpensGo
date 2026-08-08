import { makePostgresModelOperationStoreLayer } from "@xpensego/adapters/postgres/model-operation-store";
import { ModelOperationId } from "@xpensego/contracts/model/model-operation-job";
import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { UserId } from "@xpensego/domain/identity/user-id";
import { prepareModelOperation } from "@xpensego/domain/model/model-operation";
import { findModelGatewayExtractionFixture } from "@xpensego/testing/model/model-gateway-corpus";
import { Effect, Redacted, Schema } from "effect";

const probePath = "/_internal/model-gateway-proof";
const ProbeSecret = Schema.String.pipe(Schema.minLength(32), Schema.maxLength(256));
const ProbeRunId = Schema.String.pipe(Schema.pattern(/^[a-z0-9-]{1,80}$/));
const ProbeCommand = Schema.Struct({
  fixtureId: Schema.String.pipe(Schema.pattern(/^[a-z0-9-]{1,80}$/)),
  operation: Schema.Literal("startSyntheticExtraction"),
  operationId: ModelOperationId,
  runId: ProbeRunId,
  userId: UserId,
});

class InvalidModelGatewayProbeCommand extends Schema.TaggedError<InvalidModelGatewayProbeCommand>()(
  "InvalidModelGatewayProbeCommand",
  {},
) {}

class ModelOperationPublicationUnavailable extends Schema.TaggedError<ModelOperationPublicationUnavailable>()(
  "ModelOperationPublicationUnavailable",
  {},
) {}

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hasValidAuthorization(request: Request, expectedSecret: string): Promise<boolean> {
  const supplied = request.headers.get("authorization") ?? "";
  const [actualDigest, expectedDigest] = await Promise.all([
    digest(supplied),
    digest(`Bearer ${expectedSecret}`),
  ]);
  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= (actualDigest[index] ?? 0) ^ (expectedDigest[index] ?? 0);
  }
  return difference === 0;
}

function decodeCommand(request: Request) {
  return Effect.tryPromise({
    try: () => request.json(),
    catch: () => new InvalidModelGatewayProbeCommand(),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(ProbeCommand, { onExcessProperty: "error" })),
    Effect.mapError(() => new InvalidModelGatewayProbeCommand()),
  );
}

/** Enqueue one fixed synthetic staging extraction through the real durable operation path. */
export async function handleModelGatewayStagingProbe(
  request: Request,
  env: CloudflareBindings,
): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== probePath || env.ENVIRONMENT !== "staging") {
    return undefined;
  }
  const probeSecret = Schema.decodeUnknownEither(ProbeSecret)(env.PHASE1_PROBE_SECRET);
  if (probeSecret._tag === "Left" || !(await hasValidAuthorization(request, probeSecret.right))) {
    return undefined;
  }
  if (request.method !== "POST") {
    return response({ version: 1, error: { code: "method_not_allowed" } }, 405);
  }

  const program = Effect.gen(function* () {
    const command = yield* decodeCommand(request);
    const fixture = findModelGatewayExtractionFixture(command.fixtureId);
    if (fixture === undefined) {
      return yield* new InvalidModelGatewayProbeCommand();
    }
    const storeLayer = makePostgresModelOperationStoreLayer(
      Redacted.make(env.HYPERDRIVE.connectionString),
    );
    const prepared = yield* prepareModelOperation({
      canonicalInput: fixture.canonicalInput,
      inputDigest: fixture.inputDigest,
      operation: "transaction.extract.v1",
      operationId: command.operationId,
      provider: "openai",
      userId: command.userId,
    }).pipe(Effect.provide(storeLayer), Effect.scoped);
    const correlationId = Schema.decodeUnknownSync(CorrelationId)(crypto.randomUUID());
    yield* Effect.tryPromise({
      try: () =>
        env.PLATFORM_JOBS_QUEUE.send({
          version: 1,
          kind: "model.operation.ready",
          operationId: command.operationId,
          correlationId,
        }),
      catch: () => new ModelOperationPublicationUnavailable(),
    });
    return {
      version: 1,
      operation: command.operation,
      operationId: command.operationId,
      fixtureId: command.fixtureId,
      runId: command.runId,
      preparation: prepared._tag,
      queued: true,
      buildRevision: env.BUILD_REVISION ?? null,
    } as const;
  }).pipe(
    Effect.match({
      onFailure: (error) => {
        switch (error._tag) {
          case "InvalidModelGatewayProbeCommand":
            return response({ version: 1, error: { code: "invalid_probe_command" } }, 400);
          case "ModelOperationBudgetExceeded":
          case "ModelOperationKillSwitchEngaged":
            return response({ version: 1, error: { code: "model_budget_unavailable" } }, 429);
          default:
            return response({ version: 1, error: { code: "probe_unavailable" } }, 503);
        }
      },
      onSuccess: (result) => response(result, 202),
    }),
  );
  return Effect.runPromise(program);
}
