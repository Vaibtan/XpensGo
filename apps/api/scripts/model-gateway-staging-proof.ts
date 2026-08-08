import { NodeRuntime } from "@effect/platform-node";
import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { ModelOperationId } from "@xpensego/contracts/model/model-operation-job";
import { UserId } from "@xpensego/domain/identity/user-id";
import { TransactionExtractionResult } from "@xpensego/domain/model/transaction-extraction";
import {
  modelGatewayExtractionCorpusV1,
  type ModelGatewayCorpusFixture,
} from "@xpensego/testing/model/model-gateway-corpus";
import { Effect, Redacted, Schema } from "effect";

const stagingApiUrl = "https://xpensego-api-staging.vaibhav21296.workers.dev";
const Secret = Schema.String.pipe(Schema.minLength(32), Schema.maxLength(512));
const BuildRevision = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{40}$/));
const PostgresUrl = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }),
);
const Environment = Schema.Struct({
  XPENSEGO_EXPECTED_REVISION: BuildRevision,
  XPENSEGO_MIGRATION_DATABASE_URL: PostgresUrl,
  XPENSEGO_PHASE1_PROBE_SECRET: Secret,
  XPENSEGO_STAGING_API_URL: Schema.Literal(stagingApiUrl),
});
const StartResponse = Schema.Struct({
  version: Schema.Literal(1),
  fixtureId: Schema.String,
  operation: Schema.Literal("startSyntheticExtraction"),
  operationId: ModelOperationId,
  runId: Schema.String,
  preparation: Schema.Literal("Prepared", "Duplicate"),
  queued: Schema.Literal(true),
  buildRevision: BuildRevision,
});
const PersistedProof = Schema.Struct({
  attemptCount: Schema.Int.pipe(Schema.between(1, 2)),
  completionDisposition: Schema.Literal("succeeded"),
  httpDispatchCount: Schema.Int.pipe(Schema.between(1, 2)),
  inputTokens: Schema.Int.pipe(Schema.nonNegative()),
  model: Schema.Literal("gpt-5.4-nano-2026-03-17"),
  observedFailure: Schema.Null,
  operation: Schema.Literal("transaction.extract.v1"),
  outputTokens: Schema.Int.pipe(Schema.nonNegative()),
  provider: Schema.Literal("openai"),
  providerLatencyMilliseconds: Schema.Int.pipe(Schema.nonNegative()),
  providerRequestId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  reservedCostMicroUsd: Schema.Literal("0"),
  result: TransactionExtractionResult,
  settledCostMicroUsd: Schema.String,
  status: Schema.Literal("succeeded"),
});

class ModelGatewayStagingProofFailed extends Schema.TaggedError<ModelGatewayStagingProofFailed>()(
  "ModelGatewayStagingProofFailed",
  { step: Schema.String },
) {
  override get message(): string {
    return `Model gateway staging proof failed at ${this.step}.`;
  }
}

function fail(step: string) {
  return Effect.fail(new ModelGatewayStagingProofFailed({ step }));
}

function p95(values: ReadonlyArray<number>): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0;
}

const program = Effect.gen(function* () {
  const decodedEnvironment = yield* Schema.decodeUnknown(Environment)(process.env).pipe(
    Effect.mapError(() => new ModelGatewayStagingProofFailed({ step: "environment" })),
  );
  const databaseUrl = Redacted.make(decodedEnvironment.XPENSEGO_MIGRATION_DATABASE_URL);
  const databaseLayer = PgClient.layer({
    url: databaseUrl,
    applicationName: "xpensego-model-gateway-staging-proof",
    connectTimeout: "5 seconds",
    idleTimeout: "1 second",
    maxConnections: 1,
  });
  const userId = Schema.decodeUnknownSync(UserId)("605b1b40-b828-4d4d-b3f8-f8a57187a067");

  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO users (id) VALUES (${userId}) ON CONFLICT (id) DO NOTHING`;
  }).pipe(
    Effect.provide(databaseLayer),
    Effect.scoped,
    Effect.mapError(() => new ModelGatewayStagingProofFailed({ step: "seed-proof-user" })),
  );

  const runFixture = Effect.fn("ModelGatewayStagingProof.runFixture")(function* (
    fixture: ModelGatewayCorpusFixture,
  ) {
    const operationId = Schema.decodeUnknownSync(ModelOperationId)(crypto.randomUUID());
    const runId = `${fixture.fixtureId}-${Date.now().toString(36)}`;
    const startResponse = yield* Effect.tryPromise({
      try: () =>
        fetch(`${decodedEnvironment.XPENSEGO_STAGING_API_URL}/_internal/model-gateway-proof`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${decodedEnvironment.XPENSEGO_PHASE1_PROBE_SECRET}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            fixtureId: fixture.fixtureId,
            operation: "startSyntheticExtraction",
            operationId,
            runId,
            userId,
          }),
        }),
      catch: () => new ModelGatewayStagingProofFailed({ step: "start-request" }),
    });
    if (startResponse.status !== 202) {
      return yield* fail(`start-status-${startResponse.status}`);
    }
    const started = yield* Effect.tryPromise({
      try: () => startResponse.json(),
      catch: () => new ModelGatewayStagingProofFailed({ step: "start-response-json" }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknown(StartResponse, { onExcessProperty: "error" })),
      Effect.mapError(() => new ModelGatewayStagingProofFailed({ step: "start-response-schema" })),
    );
    if (
      started.operationId !== operationId ||
      started.fixtureId !== fixture.fixtureId ||
      started.buildRevision !== decodedEnvironment.XPENSEGO_EXPECTED_REVISION
    ) {
      return yield* fail("deployed-revision-operation-or-fixture");
    }

    const readProof = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<Record<string, unknown>>`
        SELECT
          operation.operation_name AS "operation",
          operation.provider,
          operation.model,
          operation.status,
          operation.completion_disposition AS "completionDisposition",
          operation.observed_failure AS "observedFailure",
          operation.http_dispatch_count AS "httpDispatchCount",
          operation.reserved_cost_micro_usd::text AS "reservedCostMicroUsd",
          operation.settled_cost_micro_usd::text AS "settledCostMicroUsd",
          operation.result_json AS result,
          operation.provider_request_id AS "providerRequestId",
          operation.input_tokens AS "inputTokens",
          operation.output_tokens AS "outputTokens",
          (SELECT COUNT(*)::int FROM model_attempts WHERE operation_id = operation.id)
            AS "attemptCount",
          (
            SELECT COALESCE(
              MAX(ROUND(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::int),
              0
            )
            FROM model_attempts
            WHERE operation_id = operation.id
          ) AS "providerLatencyMilliseconds"
        FROM model_operations AS operation
        WHERE operation.id = ${operationId}
      `;
      return row;
    }).pipe(Effect.provide(databaseLayer), Effect.scoped);

    let proof: typeof PersistedProof.Type | undefined;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const row = yield* readProof.pipe(
        Effect.mapError(() => new ModelGatewayStagingProofFailed({ step: "read-operation" })),
      );
      const decoded = Schema.decodeUnknownEither(PersistedProof)(row, {
        onExcessProperty: "error",
      });
      if (decoded._tag === "Right") {
        proof = decoded.right;
        break;
      }
      yield* Effect.sleep("500 millis");
    }
    if (proof === undefined) {
      return yield* fail("terminal-operation-timeout");
    }
    if (JSON.stringify(proof.result) !== JSON.stringify(fixture.expected)) {
      return yield* fail(`exact-output-${fixture.slice}`);
    }
    const settledCost = Number(proof.settledCostMicroUsd);
    if (!Number.isInteger(settledCost) || settledCost < 1 || settledCost > 620) {
      return yield* fail("settled-cost-ceiling");
    }
    return {
      slice: fixture.slice,
      expectedKind: fixture.expected.outcome._tag,
      providerLatencyMilliseconds: proof.providerLatencyMilliseconds,
      inputTokens: proof.inputTokens,
      outputTokens: proof.outputTokens,
      settledCostMicroUsd: settledCost,
    } as const;
  });

  const results = yield* Effect.forEach(modelGatewayExtractionCorpusV1, runFixture, {
    concurrency: 1,
  });
  const providerP95Milliseconds = p95(results.map((result) => result.providerLatencyMilliseconds));
  if (providerP95Milliseconds > 2_500) {
    return yield* fail("provider-p95-latency");
  }
  const ambiguityFixtures = results.filter(
    (result) => result.expectedKind === "ClarificationRequired",
  ).length;
  const extractedFixtures = results.length - ambiguityFixtures;

  yield* Effect.logInfo("Model gateway staging corpus proof passed", {
    corpusVersion: 1,
    fixtureCount: results.length,
    extractedFixtures,
    ambiguityFixtures,
    exactOutputAccuracyPercent: 100,
    ambiguityAccuracyPercent: 100,
    providerP95Milliseconds,
    totalInputTokens: results.reduce((total, result) => total + result.inputTokens, 0),
    totalOutputTokens: results.reduce((total, result) => total + result.outputTokens, 0),
    totalCostMicroUsd: results.reduce((total, result) => total + result.settledCostMicroUsd, 0),
    slices: results.map((result) => ({
      slice: result.slice,
      exact: true,
      providerLatencyMilliseconds: result.providerLatencyMilliseconds,
    })),
    realFinancialDataUsed: false,
  });
});

NodeRuntime.runMain(program);
