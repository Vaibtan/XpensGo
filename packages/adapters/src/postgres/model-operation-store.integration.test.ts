import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { ModelOperationId } from "@xpensego/contracts/model/model-operation-job";
import {
  ModelGateway,
  ModelProviderRateLimited,
  ModelRequestDeadlineExceeded,
  ModelStructuredOutputDecodingFailed,
  type ModelGatewayService,
} from "@xpensego/domain/model/model-gateway";
import {
  executePreparedModelOperation,
  ModelOperationStore,
  prepareModelOperation,
  restartModelOperation,
} from "@xpensego/domain/model/model-operation";
import { TransactionExtractionResult } from "@xpensego/domain/model/transaction-extraction";
import { UserId } from "@xpensego/domain/identity/user-id";
import { Effect, Layer, Ref, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { makeIsolatedTestDatabase } from "./isolated-test-database.js";
import { runMigrations } from "./migrations.js";
import { makePostgresModelOperationStoreLayer } from "./model-operation-store.js";

const testDatabase = makeIsolatedTestDatabase("xpensego_model_operation_integration");
const operationId = Schema.decodeUnknownSync(ModelOperationId)(
  "913c7c0b-b6f9-47f2-8174-a8267edc9bba",
);
const userId = Schema.decodeUnknownSync(UserId)("0a37f42e-a007-4d0d-adc2-98098f486ecc");
const inputDigest = "b210bc2b392265c489c8f87f9ba607d1868896da59676c08dfd194057695e4d2";
const fixtureOutput = {
  outcome: {
    _tag: "Extracted",
    amountMinor: 12_345,
    counterparty: "Synthetic Grocer",
    currency: "INR",
    direction: "debit",
    occurredOn: "2026-08-08",
    requiresReview: false,
  },
} as const;

const administrativeClientLayer = PgClient.layer({
  url: testDatabase.migrationUrl,
  applicationName: "xpensego-model-operation-test-setup",
  maxConnections: 1,
});

async function withFreshDatabase<A>(run: () => Promise<A>): Promise<A> {
  await Effect.runPromise(testDatabase.recreate);
  try {
    await Effect.runPromise(runMigrations(testDatabase.migrationUrl));
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO users (id) VALUES (${userId})`;
      }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
    );
    return await run();
  } finally {
    await Effect.runPromise(testDatabase.drop);
  }
}

describe("PostgreSQL Model Operation store", () => {
  it("settles one reserved attempt and prevents duplicate concurrent dispatch", async () => {
    await withFreshDatabase(async () => {
      const dispatches = await Effect.runPromise(Ref.make(0));
      const gateway: ModelGatewayService = {
        execute: (request) =>
          Ref.update(dispatches, (count) => count + 1).pipe(
            Effect.zipRight(Effect.sleep("25 millis")),
            Effect.zipRight(Schema.decodeUnknown(request.outputSchema)(fixtureOutput)),
            Effect.mapError(
              () =>
                new ModelStructuredOutputDecodingFailed({
                  attemptOrdinal: request.attemptOrdinal,
                  model: request.model,
                  operation: request.operation,
                  provider: request.provider,
                }),
            ),
            Effect.map((output) => ({
              costMicroUsd: 77,
              finishReason: "stop" as const,
              output,
              providerRequestId: "req_synthetic_01",
              usage: {
                cachedInputTokens: 0,
                inputTokens: 40,
                outputTokens: 28,
                reasoningTokens: 0,
              },
            })),
          ),
      };
      const storeLayer = makePostgresModelOperationStoreLayer(testDatabase.runtimeUrl);
      const executionLayer = Layer.merge(storeLayer, Layer.succeed(ModelGateway, gateway));

      const prepared = await Effect.runPromise(
        prepareModelOperation({
          canonicalInput: "Synthetic purchase INR 123.45 at Synthetic Grocer",
          inputDigest,
          operation: "transaction.extract.v1",
          operationId,
          provider: "openai",
          userId,
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );
      expect(prepared).toEqual({ _tag: "Prepared", operationId });

      const outcomes = await Effect.runPromise(
        Effect.all(
          [
            executePreparedModelOperation({
              operationId,
              outputSchema: TransactionExtractionResult,
            }),
            executePreparedModelOperation({
              operationId,
              outputSchema: TransactionExtractionResult,
            }),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.provide(executionLayer), Effect.scoped),
      );

      expect(outcomes.map((outcome) => outcome._tag).toSorted()).toEqual(["Deferred", "Succeeded"]);
      expect(await Effect.runPromise(Ref.get(dispatches))).toBe(1);

      const duplicate = await Effect.runPromise(
        executePreparedModelOperation({
          operationId,
          outputSchema: TransactionExtractionResult,
        }).pipe(Effect.provide(executionLayer), Effect.scoped),
      );
      expect(duplicate).toMatchObject({
        _tag: "AlreadyCompleted",
        completion: { disposition: "succeeded" },
      });

      const persisted = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [operation] = yield* sql<{
            readonly disposition: string | null;
            readonly reservedCostMicroUsd: string;
            readonly settledCostMicroUsd: string;
            readonly status: string;
          }>`
            SELECT
              completion_disposition AS "disposition",
              reserved_cost_micro_usd AS "reservedCostMicroUsd",
              settled_cost_micro_usd AS "settledCostMicroUsd",
              status
            FROM model_operations
            WHERE id = ${operationId}
          `;
          const [attemptCount] = yield* sql<{ readonly count: string }>`
            SELECT COUNT(*)::text AS count
            FROM model_attempts
            WHERE operation_id = ${operationId}
          `;
          return { attemptCount: attemptCount?.count, operation };
        }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
      );

      expect(persisted).toEqual({
        attemptCount: "1",
        operation: {
          disposition: "succeeded",
          reservedCostMicroUsd: "0",
          settledCostMicroUsd: "77",
          status: "succeeded",
        },
      });
    });
  });

  it("rejects operation-id reuse with a different canonical digest", async () => {
    await withFreshDatabase(async () => {
      const storeLayer = makePostgresModelOperationStoreLayer(testDatabase.runtimeUrl);
      const prepare = (digest: string) =>
        prepareModelOperation({
          canonicalInput: "Synthetic purchase INR 123.45 at Synthetic Grocer",
          inputDigest: digest,
          operation: "transaction.extract.v1",
          operationId,
          provider: "openai",
          userId,
        }).pipe(Effect.provide(storeLayer), Effect.scoped);

      await Effect.runPromise(prepare(inputDigest));
      const reused = await Effect.runPromise(
        prepare("c210bc2b392265c489c8f87f9ba607d1868896da59676c08dfd194057695e4d2").pipe(
          Effect.either,
        ),
      );

      expect(reused._tag).toBe("Left");
      if (reused._tag === "Left") {
        expect(reused.left._tag).toBe("ModelOperationInputConflict");
      }
    });
  });

  it("settles usage without persisting a deterministically rejected financial suggestion", async () => {
    await withFreshDatabase(async () => {
      const gateway: ModelGatewayService = {
        execute: (request) =>
          Schema.decodeUnknown(request.outputSchema)({
            outcome: { ...fixtureOutput.outcome, occurredOn: "2026-02-30" },
          }).pipe(
            Effect.mapError(
              () =>
                new ModelStructuredOutputDecodingFailed({
                  attemptOrdinal: request.attemptOrdinal,
                  model: request.model,
                  operation: request.operation,
                  provider: request.provider,
                }),
            ),
            Effect.map((output) => ({
              costMicroUsd: 77,
              finishReason: "stop" as const,
              output,
              providerRequestId: "req_synthetic_invalid_date",
              usage: {
                cachedInputTokens: 0,
                inputTokens: 40,
                outputTokens: 28,
                reasoningTokens: 0,
              },
            })),
          ),
      };
      const storeLayer = makePostgresModelOperationStoreLayer(testDatabase.runtimeUrl);
      const executionLayer = Layer.merge(storeLayer, Layer.succeed(ModelGateway, gateway));
      await Effect.runPromise(
        prepareModelOperation({
          canonicalInput: "Synthetic purchase INR 123.45 at Synthetic Grocer",
          inputDigest,
          operation: "transaction.extract.v1",
          operationId,
          provider: "openai",
          userId,
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );

      const outcome = await Effect.runPromise(
        executePreparedModelOperation({
          operationId,
          outputSchema: TransactionExtractionResult,
        }).pipe(Effect.provide(executionLayer), Effect.scoped),
      );
      expect(outcome).toMatchObject({
        _tag: "Failed",
        completion: { observedFailure: "ModelOperationDomainValidationRejected" },
      });
      const [persisted] = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            readonly providerRequestId: string;
            readonly reservedCostMicroUsd: string;
            readonly result: unknown;
            readonly settledCostMicroUsd: string;
            readonly status: string;
          }>`
            SELECT
              status,
              result_json AS result,
              provider_request_id AS "providerRequestId",
              reserved_cost_micro_usd::text AS "reservedCostMicroUsd",
              settled_cost_micro_usd::text AS "settledCostMicroUsd"
            FROM model_operations
            WHERE id = ${operationId}
          `;
        }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
      );
      expect(persisted).toEqual({
        providerRequestId: "req_synthetic_invalid_date",
        reservedCostMicroUsd: "0",
        result: null,
        settledCostMicroUsd: "77",
        status: "invalid_output",
      });
    });
  });

  it("enforces the persisted monthly ceiling and global kill switch before dispatch", async () => {
    await withFreshDatabase(async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO model_budget_accounts (
              scope_type,
              scope_key,
              period_start,
              ceiling_micro_usd
            )
            VALUES ('environment', 'development_staging', date_trunc('month', CURRENT_DATE), 619)
          `;
        }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
      );
      const storeLayer = makePostgresModelOperationStoreLayer(testDatabase.runtimeUrl);
      const prepare = () =>
        prepareModelOperation({
          canonicalInput: "Synthetic purchase INR 123.45 at Synthetic Grocer",
          inputDigest,
          operation: "transaction.extract.v1",
          operationId,
          provider: "openai",
          userId,
        }).pipe(Effect.provide(storeLayer), Effect.scoped, Effect.either);

      const overCeiling = await Effect.runPromise(prepare());
      expect(overCeiling).toMatchObject({
        _tag: "Left",
        left: { _tag: "ModelOperationBudgetExceeded", scope: "environment_month" },
      });

      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            UPDATE model_budget_accounts
            SET ceiling_micro_usd = 1000000, kill_switch = TRUE
            WHERE scope_type = 'environment'
              AND scope_key = 'development_staging'
          `;
        }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
      );
      const killed = await Effect.runPromise(prepare());
      expect(killed).toMatchObject({
        _tag: "Left",
        left: { _tag: "ModelOperationKillSwitchEngaged" },
      });
    });
  });

  it("denies the twenty-first daily provider dispatch and releases its reservation", async () => {
    await withFreshDatabase(async () => {
      const storeLayer = makePostgresModelOperationStoreLayer(testDatabase.runtimeUrl);
      await Effect.runPromise(
        prepareModelOperation({
          canonicalInput: "Synthetic purchase INR 123.45 at Synthetic Grocer",
          inputDigest,
          operation: "transaction.extract.v1",
          operationId,
          provider: "openai",
          userId,
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO model_daily_dispatch_counters (user_id, dispatch_date, dispatch_count)
            VALUES (${userId}, CURRENT_DATE, 20)
          `;
        }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
      );

      const claim = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ModelOperationStore;
          return yield* store.claim(operationId);
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );
      expect(claim).toMatchObject({
        _tag: "Rejected",
        completion: {
          disposition: "explicitly_rejected",
          observedFailure: "ModelDailyDispatchLimitExceeded",
        },
      });
      const [persisted] = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            readonly budgetReserved: string;
            readonly operationReserved: string;
            readonly status: string;
          }>`
            SELECT
              operation.status,
              operation.reserved_cost_micro_usd::text AS "operationReserved",
              budget.reserved_micro_usd::text AS "budgetReserved"
            FROM model_operations AS operation
            INNER JOIN model_budget_accounts AS budget
              ON budget.scope_type = 'environment'
              AND budget.scope_key = operation.budget_environment_key
              AND budget.period_start = operation.budget_period_start
            WHERE operation.id = ${operationId}
          `;
        }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
      );
      expect(persisted).toEqual({
        budgetReserved: "0",
        operationReserved: "0",
        status: "explicitly_rejected",
      });
    });
  });

  it("persists and consumes the single transient-429 redispatch grant", async () => {
    await withFreshDatabase(async () => {
      const dispatches = await Effect.runPromise(Ref.make(0));
      const gateway: ModelGatewayService = {
        execute: (request) =>
          Effect.gen(function* () {
            const dispatch = yield* Ref.getAndUpdate(dispatches, (count) => count + 1);
            if (dispatch === 0) {
              return yield* new ModelProviderRateLimited({
                attemptOrdinal: request.attemptOrdinal,
                classification: "transient",
                model: request.model,
                operation: request.operation,
                provider: request.provider,
                retryAfterMilliseconds: 250,
              });
            }
            const output = yield* Schema.decodeUnknown(request.outputSchema)(fixtureOutput).pipe(
              Effect.mapError(
                () =>
                  new ModelStructuredOutputDecodingFailed({
                    attemptOrdinal: request.attemptOrdinal,
                    model: request.model,
                    operation: request.operation,
                    provider: request.provider,
                  }),
              ),
            );
            return {
              costMicroUsd: 77,
              finishReason: "stop" as const,
              output,
              providerRequestId: "req_synthetic_02",
              usage: {
                cachedInputTokens: 0,
                inputTokens: 40,
                outputTokens: 28,
                reasoningTokens: 0,
              },
            };
          }),
      };
      const storeLayer = makePostgresModelOperationStoreLayer(testDatabase.runtimeUrl);
      const executionLayer = Layer.merge(storeLayer, Layer.succeed(ModelGateway, gateway));
      await Effect.runPromise(
        prepareModelOperation({
          canonicalInput: "Synthetic purchase INR 123.45 at Synthetic Grocer",
          inputDigest,
          operation: "transaction.extract.v1",
          operationId,
          provider: "openai",
          userId,
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );

      const first = await Effect.runPromise(
        executePreparedModelOperation({
          operationId,
          outputSchema: TransactionExtractionResult,
        }).pipe(Effect.provide(executionLayer), Effect.scoped),
      );
      expect(first).toEqual({ _tag: "RetryScheduled", retryAfterMilliseconds: 1_000 });

      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            UPDATE model_operations
            SET retry_not_before = CURRENT_TIMESTAMP
            WHERE id = ${operationId}
          `;
        }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
      );
      const second = await Effect.runPromise(
        executePreparedModelOperation({
          operationId,
          outputSchema: TransactionExtractionResult,
        }).pipe(Effect.provide(executionLayer), Effect.scoped),
      );
      const duplicate = await Effect.runPromise(
        executePreparedModelOperation({
          operationId,
          outputSchema: TransactionExtractionResult,
        }).pipe(Effect.provide(executionLayer), Effect.scoped),
      );

      expect(second._tag).toBe("Succeeded");
      expect(duplicate._tag).toBe("AlreadyCompleted");
      expect(await Effect.runPromise(Ref.get(dispatches))).toBe(2);
      const [persisted] = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            readonly attempts: string;
            readonly dispatches: number;
            readonly retries: number;
          }>`
            SELECT
              (SELECT COUNT(*)::text FROM model_attempts WHERE operation_id = operation.id)
                AS attempts,
              operation.http_dispatch_count AS dispatches,
              operation.transient_rate_limit_retries_used AS retries
            FROM model_operations AS operation
            WHERE operation.id = ${operationId}
          `;
        }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
      );
      expect(persisted).toEqual({ attempts: "2", dispatches: 2, retries: 1 });
    });
  });

  it("refuses a transient-429 redispatch that cannot fit the persisted operation deadline", async () => {
    await withFreshDatabase(async () => {
      const storeLayer = makePostgresModelOperationStoreLayer(testDatabase.runtimeUrl);
      await Effect.runPromise(
        prepareModelOperation({
          canonicalInput: "Synthetic purchase INR 123.45 at Synthetic Grocer",
          inputDigest,
          operation: "transaction.extract.v1",
          operationId,
          provider: "openai",
          userId,
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );
      const claimed = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ModelOperationStore;
          return yield* store.claim(operationId);
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );
      if (claimed._tag !== "Claimed") {
        throw new Error("Expected the model proof operation to be claimed");
      }
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            UPDATE model_operations
            SET deadline_at = CURRENT_TIMESTAMP + INTERVAL '100 milliseconds'
            WHERE id = ${operationId}
          `;
        }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
      );

      const completion = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ModelOperationStore;
          return yield* store.complete({
            attemptId: claimed.attempt.attemptId,
            operationId,
            result: null,
            completion: {
              disposition: "explicitly_rejected",
              observedFailure: "ModelProviderRateLimited",
              retryPlan: {
                _tag: "ScheduleTransientRateLimit",
                delayMilliseconds: 250,
              },
            },
          });
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );

      expect(completion).toEqual({
        disposition: "explicitly_rejected",
        observedFailure: "ModelProviderRateLimited",
        retryPlan: { _tag: "None" },
      });
      const [persisted] = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            readonly reservedCostMicroUsd: string;
            readonly retries: number;
            readonly status: string;
          }>`
            SELECT
              status,
              reserved_cost_micro_usd::text AS "reservedCostMicroUsd",
              transient_rate_limit_retries_used AS retries
            FROM model_operations
            WHERE id = ${operationId}
          `;
        }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
      );
      expect(persisted).toEqual({
        reservedCostMicroUsd: "0",
        retries: 0,
        status: "explicitly_rejected",
      });
    });
  });

  it("retains the reservation and never redispatches an ambiguous timeout", async () => {
    await withFreshDatabase(async () => {
      const dispatches = await Effect.runPromise(Ref.make(0));
      const gateway: ModelGatewayService = {
        execute: (request) =>
          Ref.update(dispatches, (count) => count + 1).pipe(
            Effect.zipRight(
              Effect.fail(
                new ModelRequestDeadlineExceeded({
                  attemptOrdinal: request.attemptOrdinal,
                  model: request.model,
                  operation: request.operation,
                  provider: request.provider,
                  timeoutMilliseconds: request.totalDeadlineMilliseconds,
                }),
              ),
            ),
          ),
      };
      const storeLayer = makePostgresModelOperationStoreLayer(testDatabase.runtimeUrl);
      const executionLayer = Layer.merge(storeLayer, Layer.succeed(ModelGateway, gateway));
      await Effect.runPromise(
        prepareModelOperation({
          canonicalInput: "Synthetic purchase INR 123.45 at Synthetic Grocer",
          inputDigest,
          operation: "transaction.extract.v1",
          operationId,
          provider: "openai",
          userId,
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );

      const first = await Effect.runPromise(
        executePreparedModelOperation({
          operationId,
          outputSchema: TransactionExtractionResult,
        }).pipe(Effect.provide(executionLayer), Effect.scoped),
      );
      const duplicate = await Effect.runPromise(
        executePreparedModelOperation({
          operationId,
          outputSchema: TransactionExtractionResult,
        }).pipe(Effect.provide(executionLayer), Effect.scoped),
      );

      expect(first).toMatchObject({
        _tag: "Failed",
        completion: {
          disposition: "outcome_unknown",
          observedFailure: "ModelRequestDeadlineExceeded",
          retryPlan: { _tag: "None" },
        },
      });
      expect(duplicate).toMatchObject({ _tag: "AlreadyCompleted" });
      expect(await Effect.runPromise(Ref.get(dispatches))).toBe(1);
      const [persisted] = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            readonly reservedCostMicroUsd: string;
            readonly status: string;
          }>`
            SELECT
              reserved_cost_micro_usd AS "reservedCostMicroUsd",
              status
            FROM model_operations
            WHERE id = ${operationId}
          `;
        }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
      );
      expect(persisted).toEqual({ reservedCostMicroUsd: "620", status: "outcome_unknown" });
    });
  });

  it("records lease expiry as its own durable recovery observation", async () => {
    await withFreshDatabase(async () => {
      const storeLayer = makePostgresModelOperationStoreLayer(testDatabase.runtimeUrl);
      await Effect.runPromise(
        prepareModelOperation({
          canonicalInput: "Synthetic purchase INR 123.45 at Synthetic Grocer",
          inputDigest,
          operation: "transaction.extract.v1",
          operationId,
          provider: "openai",
          userId,
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );
      const firstClaim = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ModelOperationStore;
          return yield* store.claim(operationId);
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );
      expect(firstClaim._tag).toBe("Claimed");
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            UPDATE model_operations
            SET current_lease_until = CURRENT_TIMESTAMP - INTERVAL '1 second'
            WHERE id = ${operationId}
          `;
        }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
      );

      const recovered = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ModelOperationStore;
          return yield* store.claim(operationId);
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );

      expect(recovered).toMatchObject({
        _tag: "Completed",
        completion: {
          disposition: "outcome_unknown",
          observedFailure: "ModelAttemptLeaseExpired",
          retryPlan: { _tag: "None" },
        },
      });
    });
  });

  it("rejects an expired persisted deadline before purchasing a provider dispatch", async () => {
    await withFreshDatabase(async () => {
      const storeLayer = makePostgresModelOperationStoreLayer(testDatabase.runtimeUrl);
      await Effect.runPromise(
        prepareModelOperation({
          canonicalInput: "Synthetic purchase INR 123.45 at Synthetic Grocer",
          inputDigest,
          operation: "transaction.extract.v1",
          operationId,
          provider: "openai",
          userId,
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            UPDATE model_operations
            SET deadline_at = CURRENT_TIMESTAMP - INTERVAL '1 millisecond'
            WHERE id = ${operationId}
          `;
        }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
      );

      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ModelOperationStore;
          return yield* store.claim(operationId);
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );
      expect(outcome).toMatchObject({
        _tag: "Rejected",
        completion: { observedFailure: "ModelRequestDeadlineExceededBeforeDispatch" },
      });
      const [persisted] = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            readonly attempts: string;
            readonly dispatchCounters: string;
            readonly reservedCostMicroUsd: string;
          }>`
            SELECT
              operation.reserved_cost_micro_usd::text AS "reservedCostMicroUsd",
              (SELECT COUNT(*)::text FROM model_attempts WHERE operation_id = operation.id)
                AS attempts,
              (SELECT COUNT(*)::text FROM model_daily_dispatch_counters WHERE user_id = ${userId})
                AS "dispatchCounters"
            FROM model_operations AS operation
            WHERE operation.id = ${operationId}
          `;
        }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
      );
      expect(persisted).toEqual({
        attempts: "0",
        dispatchCounters: "0",
        reservedCostMicroUsd: "0",
      });
    });
  });

  it("creates one separately reserved linked restart and exhausts the lineage grant", async () => {
    await withFreshDatabase(async () => {
      const restartedOperationId = Schema.decodeUnknownSync(ModelOperationId)(
        "3de3538d-92c8-4bc0-a63e-7133baf24a31",
      );
      const deniedOperationId = Schema.decodeUnknownSync(ModelOperationId)(
        "d67181ac-d537-4080-84d0-165b67f2187d",
      );
      const storeLayer = makePostgresModelOperationStoreLayer(testDatabase.runtimeUrl);
      await Effect.runPromise(
        prepareModelOperation({
          canonicalInput: "Synthetic purchase INR 123.45 at Synthetic Grocer",
          inputDigest,
          operation: "transaction.extract.v1",
          operationId,
          provider: "openai",
          userId,
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );
      const claim = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ModelOperationStore;
          return yield* store.claim(operationId);
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );
      if (claim._tag !== "Claimed") {
        throw new Error("Expected source operation to be claimed.");
      }
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ModelOperationStore;
          return yield* store.complete({
            attemptId: claim.attempt.attemptId,
            completion: {
              disposition: "outcome_unknown",
              observedFailure: "ModelProviderConnectionLost",
              retryPlan: { _tag: "None" },
            },
            operationId,
            result: null,
          });
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );

      const first = await Effect.runPromise(
        restartModelOperation({
          restartedOperationId,
          sourceOperationId: operationId,
          userId,
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );
      const duplicate = await Effect.runPromise(
        restartModelOperation({
          restartedOperationId,
          sourceOperationId: operationId,
          userId,
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );
      const exhausted = await Effect.runPromise(
        restartModelOperation({
          restartedOperationId: deniedOperationId,
          sourceOperationId: operationId,
          userId,
        }).pipe(Effect.provide(storeLayer), Effect.scoped, Effect.either),
      );

      expect(first).toEqual({ _tag: "Restarted", operationId: restartedOperationId });
      expect(duplicate).toEqual({ _tag: "Duplicate", operationId: restartedOperationId });
      expect(exhausted).toMatchObject({
        _tag: "Left",
        left: { _tag: "ModelOperationRestartDenied", reason: "restart_limit_exhausted" },
      });

      const [persisted] = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            readonly environmentReserved: string;
            readonly restartedFrom: string;
            readonly rootOperationId: string;
            readonly sourceReserved: string;
            readonly restartedReserved: string;
          }>`
            SELECT
              source.reserved_cost_micro_usd::text AS "sourceReserved",
              restarted.reserved_cost_micro_usd::text AS "restartedReserved",
              restarted.root_operation_id::text AS "rootOperationId",
              restarted.restarted_from_operation_id::text AS "restartedFrom",
              budget.reserved_micro_usd::text AS "environmentReserved"
            FROM model_operations AS source
            INNER JOIN model_operations AS restarted ON restarted.id = ${restartedOperationId}
            INNER JOIN model_budget_accounts AS budget
              ON budget.scope_type = 'environment'
              AND budget.scope_key = restarted.budget_environment_key
              AND budget.period_start = restarted.budget_period_start
            WHERE source.id = ${operationId}
          `;
        }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
      );
      expect(persisted).toEqual({
        environmentReserved: "1240",
        restartedFrom: operationId,
        restartedReserved: "620",
        rootOperationId: operationId,
        sourceReserved: "620",
      });
    });
  });

  it("records content-free budget thresholds and engages the kill switch at 100 percent", async () => {
    await withFreshDatabase(async () => {
      const secondOperationId = Schema.decodeUnknownSync(ModelOperationId)(
        "d15ca15f-122b-44b8-8c74-4c5737977497",
      );
      const thirdOperationId = Schema.decodeUnknownSync(ModelOperationId)(
        "91f00070-e0a4-4d26-94fa-91c567c3ed65",
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO model_budget_accounts (
              scope_type,
              scope_key,
              period_start,
              ceiling_micro_usd
            )
            VALUES ('environment', 'development_staging', date_trunc('month', CURRENT_DATE), 1240)
          `;
        }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
      );
      const storeLayer = makePostgresModelOperationStoreLayer(testDatabase.runtimeUrl);
      const prepare = (id: typeof ModelOperationId.Type) =>
        prepareModelOperation({
          canonicalInput: "Synthetic purchase INR 123.45 at Synthetic Grocer",
          inputDigest,
          operation: "transaction.extract.v1",
          operationId: id,
          provider: "openai",
          userId,
        }).pipe(Effect.provide(storeLayer), Effect.scoped);

      await Effect.runPromise(prepare(operationId));
      await Effect.runPromise(prepare(secondOperationId));
      const blockedDispatch = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ModelOperationStore;
          return yield* store.claim(secondOperationId);
        }).pipe(Effect.provide(storeLayer), Effect.scoped),
      );
      const killed = await Effect.runPromise(prepare(thirdOperationId).pipe(Effect.either));

      expect(blockedDispatch).toMatchObject({
        _tag: "Rejected",
        completion: { observedFailure: "ModelOperationKillSwitchEngaged" },
      });
      expect(killed).toMatchObject({
        _tag: "Left",
        left: { _tag: "ModelOperationKillSwitchEngaged" },
      });
      const persisted = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [budget] = yield* sql<{
            readonly killSwitch: boolean;
            readonly reservedMicroUsd: string;
          }>`
            SELECT
              kill_switch AS "killSwitch",
              reserved_micro_usd::text AS "reservedMicroUsd"
            FROM model_budget_accounts
            WHERE scope_type = 'environment'
              AND scope_key = 'development_staging'
              AND period_start = date_trunc('month', CURRENT_DATE)
          `;
          const alerts = yield* sql<{ readonly thresholdPercent: number }>`
            SELECT threshold_percent AS "thresholdPercent"
            FROM model_budget_alert_events
            WHERE scope_type = 'environment'
              AND scope_key = 'development_staging'
              AND period_start = date_trunc('month', CURRENT_DATE)
            ORDER BY threshold_percent
          `;
          return { alerts, budget };
        }).pipe(Effect.provide(administrativeClientLayer), Effect.scoped),
      );
      expect(persisted).toEqual({
        alerts: [50, 80, 90, 100].map((thresholdPercent) => ({ thresholdPercent })),
        budget: { killSwitch: true, reservedMicroUsd: "620" },
      });
    });
  });
});
