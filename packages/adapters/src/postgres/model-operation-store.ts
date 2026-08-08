import { PgClient } from "@effect/sql-pg";
import { ModelOperationId } from "@xpensego/contracts/model/model-operation-job";
import { UserId } from "@xpensego/domain/identity/user-id";
import {
  ModelAttemptId,
  ModelInputDigest,
  ModelOperationName,
  type ModelRetryPlan,
} from "@xpensego/domain/model/model-gateway";
import {
  ModelAttemptLeaseExpired,
  ModelDailyDispatchLimitExceeded,
  ModelOperationBudgetExceeded,
  ModelOperationInputConflict,
  ModelOperationKillSwitchEngaged,
  ModelOperationNotFound,
  ModelOperationDispatchLimitExceeded,
  ModelOperationPersistenceUnavailable,
  ModelOperationRestartConflict,
  ModelOperationRestartDenied,
  ModelRequestDeadlineExceededBeforeDispatch,
  ModelOperationStore,
  type CompleteModelOperationInput,
  type ModelOperationCompletion,
  type ModelOperationStoreService,
  type PrepareModelOperationStoreInput,
} from "@xpensego/domain/model/model-operation";
import { Effect, Layer, Schema, type Redacted } from "effect";

const CompletionDisposition = Schema.Literal(
  "succeeded",
  "explicitly_rejected",
  "invalid_output",
  "outcome_unknown",
);
const ObservedFailure = Schema.Literal(
  "ModelAttemptLeaseExpired",
  "ModelRequestDeadlineExceededBeforeDispatch",
  "ModelDailyDispatchLimitExceeded",
  "ModelFixtureMissing",
  "ModelProviderConnectionLost",
  "ModelProviderEmptyResponse",
  "ModelProviderHttp5xx",
  "ModelProviderMalformedResponse",
  "ModelProviderQuotaDenied",
  "ModelProviderRateLimited",
  "ModelProviderRefusal",
  "ModelProviderRequestRejected",
  "ModelProviderTruncated",
  "ModelRequestDeadlineExceeded",
  "ModelSchemaUnsupported",
  "ModelStructuredOutputDecodingFailed",
  "ModelOperationKillSwitchEngaged",
  "ModelOperationDomainValidationRejected",
  "ModelOperationDispatchLimitExceeded",
);
const RetryPlanName = Schema.Literal("none", "schedule_transient_429");

const ExistingOperationRow = Schema.Struct({ inputDigest: ModelInputDigest });
const ExistingRestartRow = Schema.Struct({
  restartedFromOperationId: Schema.NullOr(ModelOperationId),
  rootOperationId: ModelOperationId,
  userId: UserId,
});
const BudgetRow = Schema.Struct({
  ceilingMicroUsd: Schema.String,
  killSwitch: Schema.Boolean,
  reservedMicroUsd: Schema.String,
  scopeKey: Schema.String,
  scopeType: Schema.Literal("environment", "user"),
  settledMicroUsd: Schema.String,
});
const InsertedOperationRow = Schema.Struct({ operationId: ModelOperationId });
const InsertedAttemptRow = Schema.Struct({ attemptId: ModelAttemptId });
const OperationRow = Schema.Struct({
  budgetEnvironmentKey: Schema.Literal("development_staging", "alpha"),
  budgetPeriodStart: Schema.String,
  canonicalInput: Schema.String,
  completionDisposition: Schema.NullOr(CompletionDisposition),
  currentAttemptId: Schema.NullOr(ModelAttemptId),
  currentLeaseUntil: Schema.NullOr(Schema.DateFromSelf),
  currentTime: Schema.DateFromSelf,
  dailyDispatchLimit: Schema.Int.pipe(Schema.positive()),
  deadlineAt: Schema.DateFromSelf,
  httpDispatchCount: Schema.Int.pipe(Schema.nonNegative()),
  inputDigest: ModelInputDigest,
  environmentMonthlyCeilingMicroUsd: Schema.String,
  explicitRestartLimit: Schema.Int.pipe(Schema.nonNegative()),
  maximumHttpDispatches: Schema.Int.pipe(Schema.positive()),
  model: Schema.String,
  observedFailure: Schema.NullOr(ObservedFailure),
  operation: ModelOperationName,
  operationVersion: Schema.Int.pipe(Schema.positive()),
  operationId: ModelOperationId,
  outputTokenLimit: Schema.Int.pipe(Schema.positive()),
  promptVersion: Schema.Int.pipe(Schema.positive()),
  provider: Schema.Literal("deterministic", "openai"),
  providerTimeoutMilliseconds: Schema.Int.pipe(Schema.positive()),
  reservedCostMicroUsd: Schema.String,
  retryNotBefore: Schema.NullOr(Schema.DateFromSelf),
  retryPlan: RetryPlanName,
  retryPolicyVersion: Schema.Int.pipe(Schema.positive()),
  rootOperationId: ModelOperationId,
  schemaVersion: Schema.Int.pipe(Schema.positive()),
  status: Schema.Literal(
    "prepared",
    "dispatched",
    "retry_scheduled",
    "succeeded",
    "explicitly_rejected",
    "invalid_output",
    "outcome_unknown",
  ),
  transientRateLimitRetriesUsed: Schema.Int.pipe(Schema.nonNegative()),
  transientRateLimitRetryLimit: Schema.Int.pipe(Schema.nonNegative()),
  totalDeadlineMilliseconds: Schema.Int.pipe(Schema.positive()),
  userMonthlyCeilingMicroUsd: Schema.String,
  userId: UserId,
});

type OperationRow = typeof OperationRow.Type;

function persistenceUnavailable(
  operation: ModelOperationPersistenceUnavailable["operation"],
): ModelOperationPersistenceUnavailable {
  return new ModelOperationPersistenceUnavailable({ operation });
}

function observePersistenceFailure(
  operation: ModelOperationPersistenceUnavailable["operation"],
  cause: unknown,
) {
  return Effect.logWarning("PostgreSQL model operation failed", {
    operation,
    causeTag: cause instanceof Error ? cause.name : "UnknownFailure",
  });
}

function toRetryPlan(name: typeof RetryPlanName.Type, retryAfterMilliseconds = 0): ModelRetryPlan {
  return name === "schedule_transient_429"
    ? {
        _tag: "ScheduleTransientRateLimit",
        delayMilliseconds: retryAfterMilliseconds,
      }
    : { _tag: "None" };
}

function toCompletion(row: OperationRow): ModelOperationCompletion {
  if (row.completionDisposition === null) {
    throw new Error("Terminal model operation is missing a completion disposition");
  }
  const retryAfterMilliseconds =
    row.retryNotBefore === null ? 0 : Math.max(0, row.retryNotBefore.getTime() - Date.now());
  return {
    disposition: row.completionDisposition,
    observedFailure: row.observedFailure,
    retryPlan: toRetryPlan(row.retryPlan, retryAfterMilliseconds),
  };
}

function parseMicroUsd(value: string): bigint {
  return BigInt(value);
}

function isConservativelyBillableFailure(
  failure: ModelOperationCompletion["observedFailure"],
): boolean {
  return (
    failure === "ModelProviderRefusal" ||
    failure === "ModelProviderTruncated" ||
    failure === "ModelStructuredOutputDecodingFailed"
  );
}

/** PostgreSQL durable model-operation implementation requiring an already-scoped client. */
export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;

  const recordBudgetThresholds = (input: {
    readonly environmentBudgetKey: string;
    readonly periodStart: string;
    readonly userId: typeof UserId.Type;
  }) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO model_budget_alert_events (
          scope_type,
          scope_key,
          period_start,
          threshold_percent
        )
        SELECT
          budget.scope_type,
          budget.scope_key,
          budget.period_start,
          threshold.threshold_percent
        FROM model_budget_accounts AS budget
        CROSS JOIN (VALUES (50), (80), (90), (100)) AS threshold(threshold_percent)
        WHERE budget.period_start = ${input.periodStart}::date
          AND budget.ceiling_micro_usd > 0
          AND (
            (budget.scope_type = 'environment' AND budget.scope_key = ${input.environmentBudgetKey})
            OR (budget.scope_type = 'user' AND budget.scope_key = ${input.userId})
          )
          AND (budget.reserved_micro_usd + budget.settled_micro_usd) * 100
            >= budget.ceiling_micro_usd * threshold.threshold_percent
        ON CONFLICT (scope_type, scope_key, period_start, threshold_percent) DO NOTHING
      `;
      yield* sql`
        UPDATE model_budget_accounts
        SET kill_switch = TRUE, updated_at = CURRENT_TIMESTAMP
        WHERE scope_type = 'environment'
          AND scope_key = ${input.environmentBudgetKey}
          AND period_start = ${input.periodStart}::date
          AND ceiling_micro_usd > 0
          AND reserved_micro_usd + settled_micro_usd >= ceiling_micro_usd
      `;
    });

  const prepare: ModelOperationStoreService["prepare"] = Effect.fn(
    "PostgresModelOperation.prepare",
  )(function* (input: PrepareModelOperationStoreInput) {
    const transaction = Effect.gen(function* () {
      const existingRows = yield* sql<{ readonly inputDigest: unknown }>`
        SELECT input_digest AS "inputDigest"
        FROM model_operations
        WHERE id = ${input.operationId}
      `;
      if (existingRows.length > 0) {
        const existing = yield* Schema.decodeUnknown(ExistingOperationRow)(existingRows[0]);
        if (existing.inputDigest !== input.inputDigest) {
          return yield* new ModelOperationInputConflict({ operationId: input.operationId });
        }
        return { _tag: "Duplicate", operationId: input.operationId } as const;
      }

      const periodStartRows = yield* sql<{ readonly periodStart: unknown }>`
        SELECT date_trunc('month', CURRENT_DATE)::date::text AS "periodStart"
      `;
      const periodStart = yield* Schema.decodeUnknown(
        Schema.Struct({ periodStart: Schema.String }),
      )(periodStartRows[0]);

      if (input.reservedCostMicroUsd > 0) {
        yield* sql`
          INSERT INTO model_budget_accounts (
            scope_type,
            scope_key,
            period_start,
            ceiling_micro_usd
          )
          VALUES
            (
              'environment',
              ${input.environmentBudgetKey},
              ${periodStart.periodStart}::date,
              ${input.environmentMonthlyCeilingMicroUsd}
            ),
            (
              'user',
              ${input.userId},
              ${periodStart.periodStart}::date,
              ${input.userMonthlyCeilingMicroUsd}
            )
          ON CONFLICT (scope_type, scope_key, period_start) DO NOTHING
        `;

        const budgetRows = yield* sql<{
          readonly ceilingMicroUsd: unknown;
          readonly killSwitch: unknown;
          readonly reservedMicroUsd: unknown;
          readonly scopeKey: unknown;
          readonly scopeType: unknown;
          readonly settledMicroUsd: unknown;
        }>`
          SELECT
            scope_type AS "scopeType",
            scope_key AS "scopeKey",
            ceiling_micro_usd::text AS "ceilingMicroUsd",
            reserved_micro_usd::text AS "reservedMicroUsd",
            settled_micro_usd::text AS "settledMicroUsd",
            kill_switch AS "killSwitch"
          FROM model_budget_accounts
          WHERE period_start = ${periodStart.periodStart}::date
            AND (
              (scope_type = 'environment' AND scope_key = ${input.environmentBudgetKey})
              OR (scope_type = 'user' AND scope_key = ${input.userId})
            )
          ORDER BY scope_type, scope_key
          FOR UPDATE
        `;
        const budgets = yield* Schema.decodeUnknown(Schema.Array(BudgetRow))(budgetRows);
        if (budgets.length !== 2) {
          return yield* Effect.fail(persistenceUnavailable("prepare"));
        }

        const operationAfterLock = yield* sql<{ readonly inputDigest: unknown }>`
          SELECT input_digest AS "inputDigest"
          FROM model_operations
          WHERE id = ${input.operationId}
        `;
        if (operationAfterLock.length > 0) {
          const existing = yield* Schema.decodeUnknown(ExistingOperationRow)(operationAfterLock[0]);
          if (existing.inputDigest !== input.inputDigest) {
            return yield* new ModelOperationInputConflict({ operationId: input.operationId });
          }
          return { _tag: "Duplicate", operationId: input.operationId } as const;
        }

        const environmentBudget = budgets.find((budget) => budget.scopeType === "environment");
        const userBudget = budgets.find((budget) => budget.scopeType === "user");
        if (environmentBudget?.killSwitch === true) {
          return yield* new ModelOperationKillSwitchEngaged({
            budgetKey: input.environmentBudgetKey,
          });
        }
        const reservation = BigInt(input.reservedCostMicroUsd);
        if (
          environmentBudget === undefined ||
          parseMicroUsd(environmentBudget.reservedMicroUsd) +
            parseMicroUsd(environmentBudget.settledMicroUsd) +
            reservation >
            parseMicroUsd(environmentBudget.ceilingMicroUsd)
        ) {
          return yield* new ModelOperationBudgetExceeded({ scope: "environment_month" });
        }
        if (
          userBudget === undefined ||
          parseMicroUsd(userBudget.reservedMicroUsd) +
            parseMicroUsd(userBudget.settledMicroUsd) +
            reservation >
            parseMicroUsd(userBudget.ceilingMicroUsd)
        ) {
          return yield* new ModelOperationBudgetExceeded({ scope: "user_month" });
        }

        yield* sql`
          UPDATE model_budget_accounts
          SET
            reserved_micro_usd = reserved_micro_usd + ${input.reservedCostMicroUsd},
            updated_at = CURRENT_TIMESTAMP
          WHERE period_start = ${periodStart.periodStart}::date
            AND (
              (scope_type = 'environment' AND scope_key = ${input.environmentBudgetKey})
              OR (scope_type = 'user' AND scope_key = ${input.userId})
            )
        `;
        yield* recordBudgetThresholds({
          environmentBudgetKey: input.environmentBudgetKey,
          periodStart: periodStart.periodStart,
          userId: input.userId,
        });
      }

      const insertedRows = yield* sql<{ readonly operationId: unknown }>`
        INSERT INTO model_operations (
          id,
          root_operation_id,
          user_id,
          operation_name,
          operation_version,
          retry_policy_version,
          prompt_version,
          schema_version,
          input_digest,
          canonical_input,
          provider,
          model,
          deadline_at,
          maximum_http_dispatches,
          maximum_input_utf8_bytes,
          maximum_potentially_billable_attempts,
          transient_rate_limit_retry_limit,
          explicit_restart_limit,
          output_token_limit,
          provider_timeout_milliseconds,
          total_deadline_milliseconds,
          daily_dispatch_limit,
          budget_environment_key,
          budget_period_start,
          environment_monthly_ceiling_micro_usd,
          user_monthly_ceiling_micro_usd,
          reserved_cost_micro_usd
        )
        VALUES (
          ${input.operationId},
          ${input.operationId},
          ${input.userId},
          ${input.operation},
          ${input.profile.operationVersion},
          ${input.profile.retryPolicyVersion},
          ${input.profile.promptVersion},
          ${input.profile.schemaVersion},
          ${input.inputDigest},
          ${input.canonicalInput},
          ${input.provider},
          ${input.profile.model},
          CURRENT_TIMESTAMP + (${input.profile.totalDeadlineMilliseconds} * INTERVAL '1 millisecond'),
          ${input.profile.maximumHttpDispatches},
          ${input.profile.maximumInputUtf8Bytes},
          ${input.profile.maximumPotentiallyBillableAttempts},
          ${input.profile.transientRateLimitRetryLimit},
          ${input.explicitRestartLimit},
          ${input.profile.outputTokenLimit},
          ${input.profile.providerTimeoutMilliseconds},
          ${input.profile.totalDeadlineMilliseconds},
          ${input.dailyDispatchLimit},
          ${input.environmentBudgetKey},
          ${periodStart.periodStart}::date,
          ${input.environmentMonthlyCeilingMicroUsd},
          ${input.userMonthlyCeilingMicroUsd},
          ${input.reservedCostMicroUsd}
        )
        RETURNING id AS "operationId"
      `;
      const inserted = yield* Schema.decodeUnknown(InsertedOperationRow)(insertedRows[0]);
      return { _tag: "Prepared", operationId: inserted.operationId } as const;
    });

    return yield* sql.withTransaction(transaction).pipe(
      Effect.tapError((cause) =>
        cause instanceof ModelOperationBudgetExceeded ||
        cause instanceof ModelOperationInputConflict ||
        cause instanceof ModelOperationKillSwitchEngaged
          ? Effect.void
          : observePersistenceFailure("prepare", cause),
      ),
      Effect.mapError((cause) =>
        cause instanceof ModelOperationBudgetExceeded ||
        cause instanceof ModelOperationInputConflict ||
        cause instanceof ModelOperationKillSwitchEngaged
          ? cause
          : persistenceUnavailable("prepare"),
      ),
    );
  });

  const readOperationForUpdate = (operationId: typeof ModelOperationId.Type) =>
    Effect.gen(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        SELECT
          id AS "operationId",
          root_operation_id AS "rootOperationId",
          user_id AS "userId",
          operation_name AS "operation",
          operation_version AS "operationVersion",
          retry_policy_version AS "retryPolicyVersion",
          input_digest AS "inputDigest",
          canonical_input AS "canonicalInput",
          provider,
          model,
          status,
          completion_disposition AS "completionDisposition",
          observed_failure AS "observedFailure",
          retry_plan AS "retryPlan",
          retry_not_before AS "retryNotBefore",
          current_attempt_id AS "currentAttemptId",
          current_lease_until AS "currentLeaseUntil",
          CURRENT_TIMESTAMP AS "currentTime",
          deadline_at AS "deadlineAt",
          maximum_http_dispatches AS "maximumHttpDispatches",
          explicit_restart_limit AS "explicitRestartLimit",
          http_dispatch_count AS "httpDispatchCount",
          transient_rate_limit_retry_limit AS "transientRateLimitRetryLimit",
          transient_rate_limit_retries_used AS "transientRateLimitRetriesUsed",
          prompt_version AS "promptVersion",
          schema_version AS "schemaVersion",
          output_token_limit AS "outputTokenLimit",
          provider_timeout_milliseconds AS "providerTimeoutMilliseconds",
          total_deadline_milliseconds AS "totalDeadlineMilliseconds",
          daily_dispatch_limit AS "dailyDispatchLimit",
          budget_environment_key AS "budgetEnvironmentKey",
          budget_period_start::text AS "budgetPeriodStart",
          environment_monthly_ceiling_micro_usd::text AS "environmentMonthlyCeilingMicroUsd",
          user_monthly_ceiling_micro_usd::text AS "userMonthlyCeilingMicroUsd",
          reserved_cost_micro_usd::text AS "reservedCostMicroUsd"
        FROM model_operations
        WHERE id = ${operationId}
        FOR UPDATE
      `;
      if (rows.length === 0) {
        return yield* new ModelOperationNotFound({ operationId });
      }
      return yield* Schema.decodeUnknown(OperationRow)(rows[0]);
    });

  const releaseReservation = (row: OperationRow, settlementMicroUsd: bigint) =>
    row.provider === "deterministic" || parseMicroUsd(row.reservedCostMicroUsd) === 0n
      ? Effect.void
      : sql`
          UPDATE model_budget_accounts
          SET
            reserved_micro_usd = reserved_micro_usd - ${row.reservedCostMicroUsd},
            settled_micro_usd = settled_micro_usd + ${settlementMicroUsd.toString()},
            updated_at = CURRENT_TIMESTAMP
          WHERE period_start = ${row.budgetPeriodStart}::date
            AND (
              (scope_type = 'environment' AND scope_key = ${row.budgetEnvironmentKey})
              OR (scope_type = 'user' AND scope_key = ${row.userId})
            )
        `.pipe(Effect.asVoid);

  const claim: ModelOperationStoreService["claim"] = Effect.fn("PostgresModelOperation.claim")(
    function* (operationId) {
      const transaction = Effect.gen(function* () {
        const row = yield* readOperationForUpdate(operationId);
        const now = row.currentTime.getTime();

        if (
          row.status === "succeeded" ||
          row.status === "explicitly_rejected" ||
          row.status === "invalid_output" ||
          row.status === "outcome_unknown"
        ) {
          return { _tag: "Completed", completion: toCompletion(row) } as const;
        }

        if (row.status === "dispatched") {
          if (row.currentAttemptId === null || row.currentLeaseUntil === null) {
            return yield* Effect.fail(persistenceUnavailable("claim"));
          }
          if (row.currentLeaseUntil.getTime() > now) {
            return {
              _tag: "Deferred",
              retryAfterMilliseconds: Math.max(1, row.currentLeaseUntil.getTime() - now),
            } as const;
          }

          const leaseFailure = new ModelAttemptLeaseExpired({
            attemptId: row.currentAttemptId,
            operationId,
          });
          yield* sql`
          UPDATE model_attempts
          SET
            status = 'completed',
            completion_disposition = 'outcome_unknown',
            observed_failure = ${leaseFailure._tag},
            retry_plan = 'none',
            completed_at = CURRENT_TIMESTAMP
          WHERE id = ${row.currentAttemptId}
            AND status = 'dispatched'
        `;
          yield* sql`
          UPDATE model_operations
          SET
            status = 'outcome_unknown',
            completion_disposition = 'outcome_unknown',
            observed_failure = ${leaseFailure._tag},
            retry_plan = 'none',
            retry_not_before = NULL,
            current_attempt_id = NULL,
            current_lease_until = NULL,
            updated_at = CURRENT_TIMESTAMP,
            completed_at = CURRENT_TIMESTAMP
          WHERE id = ${operationId}
        `;
          return {
            _tag: "Completed",
            completion: {
              disposition: "outcome_unknown",
              observedFailure: leaseFailure._tag,
              retryPlan: { _tag: "None" },
            },
          } as const;
        }

        if (
          row.status === "retry_scheduled" &&
          row.retryNotBefore !== null &&
          row.retryNotBefore.getTime() > now
        ) {
          return {
            _tag: "Deferred",
            retryAfterMilliseconds: Math.max(1, row.retryNotBefore.getTime() - now),
          } as const;
        }

        if (row.deadlineAt.getTime() <= now) {
          const deadlineFailure = new ModelRequestDeadlineExceededBeforeDispatch({ operationId });
          yield* releaseReservation(row, 0n);
          yield* sql`
            UPDATE model_operations
            SET
              status = 'explicitly_rejected',
              completion_disposition = 'explicitly_rejected',
              observed_failure = ${deadlineFailure._tag},
              retry_plan = 'none',
              retry_not_before = NULL,
              current_attempt_id = NULL,
              current_lease_until = NULL,
              reserved_cost_micro_usd = 0,
              updated_at = CURRENT_TIMESTAMP,
              completed_at = CURRENT_TIMESTAMP
            WHERE id = ${operationId}
          `;
          return {
            _tag: "Rejected",
            completion: {
              disposition: "explicitly_rejected",
              observedFailure: deadlineFailure._tag,
              retryPlan: { _tag: "None" },
            },
          } as const;
        }

        if (row.httpDispatchCount >= row.maximumHttpDispatches) {
          const dispatchFailure = new ModelOperationDispatchLimitExceeded({
            limit: row.maximumHttpDispatches,
          });
          yield* releaseReservation(row, 0n);
          yield* sql`
          UPDATE model_operations
          SET
            status = 'explicitly_rejected',
            completion_disposition = 'explicitly_rejected',
            observed_failure = ${dispatchFailure._tag},
            retry_plan = 'none',
            retry_not_before = NULL,
            current_attempt_id = NULL,
            current_lease_until = NULL,
            reserved_cost_micro_usd = 0,
            updated_at = CURRENT_TIMESTAMP,
            completed_at = CURRENT_TIMESTAMP
          WHERE id = ${operationId}
        `;
          return {
            _tag: "Rejected",
            completion: {
              disposition: "explicitly_rejected",
              observedFailure: dispatchFailure._tag,
              retryPlan: { _tag: "None" },
            },
          } as const;
        }

        if (row.provider === "openai") {
          const [budgetControl] = yield* sql<{ readonly killSwitch: unknown }>`
            SELECT kill_switch AS "killSwitch"
            FROM model_budget_accounts
            WHERE scope_type = 'environment'
              AND scope_key = ${row.budgetEnvironmentKey}
              AND period_start = ${row.budgetPeriodStart}::date
            FOR SHARE
          `;
          const control = yield* Schema.decodeUnknown(
            Schema.Struct({ killSwitch: Schema.Boolean }),
          )(budgetControl);
          if (control.killSwitch) {
            const killFailure = new ModelOperationKillSwitchEngaged({
              budgetKey: row.budgetEnvironmentKey,
            });
            yield* releaseReservation(row, 0n);
            yield* sql`
              UPDATE model_operations
              SET
                status = 'explicitly_rejected',
                completion_disposition = 'explicitly_rejected',
                observed_failure = ${killFailure._tag},
                retry_plan = 'none',
                retry_not_before = NULL,
                reserved_cost_micro_usd = 0,
                updated_at = CURRENT_TIMESTAMP,
                completed_at = CURRENT_TIMESTAMP
              WHERE id = ${operationId}
            `;
            return {
              _tag: "Rejected",
              completion: {
                disposition: "explicitly_rejected",
                observedFailure: killFailure._tag,
                retryPlan: { _tag: "None" },
              },
            } as const;
          }

          const dispatchRows = yield* sql<{ readonly dispatchCount: unknown }>`
          INSERT INTO model_daily_dispatch_counters (user_id, dispatch_date, dispatch_count)
          VALUES (${row.userId}, CURRENT_DATE, 1)
          ON CONFLICT (user_id, dispatch_date) DO UPDATE
          SET
            dispatch_count = model_daily_dispatch_counters.dispatch_count + 1,
            updated_at = CURRENT_TIMESTAMP
          WHERE model_daily_dispatch_counters.dispatch_count < ${row.dailyDispatchLimit}
          RETURNING dispatch_count AS "dispatchCount"
        `;
          if (dispatchRows.length === 0) {
            const dailyFailure = new ModelDailyDispatchLimitExceeded({
              limit: row.dailyDispatchLimit,
            });
            yield* releaseReservation(row, 0n);
            yield* sql`
            UPDATE model_operations
            SET
              status = 'explicitly_rejected',
              completion_disposition = 'explicitly_rejected',
              observed_failure = ${dailyFailure._tag},
              retry_plan = 'none',
              retry_not_before = NULL,
              reserved_cost_micro_usd = 0,
              updated_at = CURRENT_TIMESTAMP,
              completed_at = CURRENT_TIMESTAMP
            WHERE id = ${operationId}
          `;
            return {
              _tag: "Rejected",
              completion: {
                disposition: "explicitly_rejected",
                observedFailure: dailyFailure._tag,
                retryPlan: { _tag: "None" },
              },
            } as const;
          }
        }

        const attemptOrdinal = row.httpDispatchCount + 1;
        const attemptRows = yield* sql<{ readonly attemptId: unknown }>`
        INSERT INTO model_attempts (id, operation_id, attempt_ordinal, leased_until)
        VALUES (
          gen_random_uuid(),
          ${operationId},
          ${attemptOrdinal},
          CURRENT_TIMESTAMP + INTERVAL '30 seconds'
        )
        RETURNING id AS "attemptId"
      `;
        const { attemptId } = yield* Schema.decodeUnknown(InsertedAttemptRow)(attemptRows[0]);
        yield* sql`
        UPDATE model_operations
        SET
          status = 'dispatched',
          completion_disposition = NULL,
          observed_failure = NULL,
          retry_plan = 'none',
          retry_not_before = NULL,
          current_attempt_id = ${attemptId},
          current_lease_until = CURRENT_TIMESTAMP + INTERVAL '30 seconds',
          http_dispatch_count = http_dispatch_count + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${operationId}
      `;

        return {
          _tag: "Claimed",
          attempt: {
            attemptId,
            attemptOrdinal,
            canonicalInput: row.canonicalInput,
            inputDigest: row.inputDigest,
            model: row.model,
            operation: row.operation,
            operationId: row.operationId,
            outputTokenLimit: row.outputTokenLimit,
            promptVersion: row.promptVersion,
            provider: row.provider,
            providerTimeoutMilliseconds: Math.min(
              row.providerTimeoutMilliseconds,
              Math.max(1, row.deadlineAt.getTime() - now),
            ),
            schemaVersion: row.schemaVersion,
            totalDeadlineMilliseconds: Math.max(1, row.deadlineAt.getTime() - now),
            transientRateLimitRetryAvailable:
              row.transientRateLimitRetriesUsed < row.transientRateLimitRetryLimit,
          },
        } as const;
      });

      return yield* sql.withTransaction(transaction).pipe(
        Effect.tapError((cause) =>
          cause instanceof ModelOperationBudgetExceeded || cause instanceof ModelOperationNotFound
            ? Effect.void
            : observePersistenceFailure("claim", cause),
        ),
        Effect.mapError((cause) =>
          cause instanceof ModelOperationBudgetExceeded || cause instanceof ModelOperationNotFound
            ? cause
            : persistenceUnavailable("claim"),
        ),
      );
    },
  );

  const complete: ModelOperationStoreService["complete"] = Effect.fn(
    "PostgresModelOperation.complete",
  )(function* <A>(input: CompleteModelOperationInput<A>) {
    const transaction = Effect.gen(function* () {
      const row = yield* readOperationForUpdate(input.operationId);
      if (row.status !== "dispatched" || row.currentAttemptId !== input.attemptId) {
        if (
          row.status === "succeeded" ||
          row.status === "explicitly_rejected" ||
          row.status === "invalid_output" ||
          row.status === "outcome_unknown"
        ) {
          return toCompletion(row);
        }
        return yield* Effect.fail(persistenceUnavailable("complete"));
      }

      let completion = input.completion;
      const providerRetryDelay =
        completion.retryPlan._tag === "ScheduleTransientRateLimit"
          ? completion.retryPlan.delayMilliseconds
          : null;
      const effectiveRetryDelay =
        providerRetryDelay === null ? null : Math.max(1_000, providerRetryDelay);
      const retryFitsDeadline =
        effectiveRetryDelay !== null &&
        row.currentTime.getTime() + effectiveRetryDelay <= row.deadlineAt.getTime();
      if (effectiveRetryDelay !== null) {
        completion = {
          ...completion,
          retryPlan: retryFitsDeadline
            ? {
                _tag: "ScheduleTransientRateLimit",
                delayMilliseconds: effectiveRetryDelay,
              }
            : { _tag: "None" },
        };
      }
      const retryPlanName =
        completion.retryPlan._tag === "ScheduleTransientRateLimit"
          ? "schedule_transient_429"
          : "none";
      yield* sql`
        UPDATE model_attempts
        SET
          status = 'completed',
          completion_disposition = ${completion.disposition},
          observed_failure = ${completion.observedFailure},
          retry_plan = ${retryPlanName},
          provider_request_id = ${input.result?.providerRequestId ?? null},
          input_tokens = ${input.result?.usage.inputTokens ?? null},
          cached_input_tokens = ${input.result?.usage.cachedInputTokens ?? null},
          output_tokens = ${input.result?.usage.outputTokens ?? null},
          reasoning_tokens = ${input.result?.usage.reasoningTokens ?? null},
          cost_micro_usd = ${input.result?.costMicroUsd ?? null},
          completed_at = CURRENT_TIMESTAMP
        WHERE id = ${input.attemptId}
          AND status = 'dispatched'
      `;

      if (completion.retryPlan._tag === "ScheduleTransientRateLimit") {
        yield* sql`
          UPDATE model_operations
          SET
            status = 'retry_scheduled',
            completion_disposition = 'explicitly_rejected',
            observed_failure = ${completion.observedFailure},
            retry_plan = 'schedule_transient_429',
            retry_not_before = CURRENT_TIMESTAMP
              + (${completion.retryPlan.delayMilliseconds} * INTERVAL '1 millisecond'),
            current_attempt_id = NULL,
            current_lease_until = NULL,
            transient_rate_limit_retries_used = transient_rate_limit_retries_used + 1,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ${input.operationId}
        `;
        return completion;
      }

      const reservedCost = parseMicroUsd(row.reservedCostMicroUsd);
      const settlement =
        input.result !== null
          ? BigInt(input.result.costMicroUsd)
          : isConservativelyBillableFailure(completion.observedFailure)
            ? reservedCost
            : 0n;
      const retainsReservation = completion.disposition === "outcome_unknown";
      if (!retainsReservation) {
        yield* releaseReservation(row, settlement);
      }

      yield* sql`
        UPDATE model_operations
        SET
          status = ${completion.disposition},
          completion_disposition = ${completion.disposition},
          observed_failure = ${completion.observedFailure},
          retry_plan = 'none',
          retry_not_before = NULL,
          current_attempt_id = NULL,
          current_lease_until = NULL,
          reserved_cost_micro_usd = ${retainsReservation ? reservedCost.toString() : "0"},
          settled_cost_micro_usd = settled_cost_micro_usd + ${settlement.toString()},
          result_json = ${
            input.result === null || completion.disposition !== "succeeded"
              ? null
              : sql.json(input.result.output)
          },
          provider_request_id = ${input.result?.providerRequestId ?? null},
          input_tokens = ${input.result?.usage.inputTokens ?? null},
          cached_input_tokens = ${input.result?.usage.cachedInputTokens ?? null},
          output_tokens = ${input.result?.usage.outputTokens ?? null},
          reasoning_tokens = ${input.result?.usage.reasoningTokens ?? null},
          updated_at = CURRENT_TIMESTAMP,
          completed_at = CURRENT_TIMESTAMP
        WHERE id = ${input.operationId}
      `;
      return completion;
    });

    return yield* sql.withTransaction(transaction).pipe(
      Effect.tapError((cause) =>
        cause instanceof ModelOperationNotFound
          ? Effect.void
          : observePersistenceFailure("complete", cause),
      ),
      Effect.mapError((cause) =>
        cause instanceof ModelOperationNotFound ? cause : persistenceUnavailable("complete"),
      ),
    );
  });

  const restart: ModelOperationStoreService["restart"] = Effect.fn(
    "PostgresModelOperation.restart",
  )(function* (input) {
    const transaction = Effect.gen(function* () {
      const source = yield* readOperationForUpdate(input.sourceOperationId);
      if (source.userId !== input.userId) {
        return yield* new ModelOperationNotFound({ operationId: input.sourceOperationId });
      }

      const existingRows = yield* sql<Record<string, unknown>>`
        SELECT
          root_operation_id AS "rootOperationId",
          restarted_from_operation_id AS "restartedFromOperationId",
          user_id AS "userId"
        FROM model_operations
        WHERE id = ${input.restartedOperationId}
      `;
      if (existingRows.length > 0) {
        const existing = yield* Schema.decodeUnknown(ExistingRestartRow)(existingRows[0]);
        if (
          existing.rootOperationId !== source.rootOperationId ||
          existing.restartedFromOperationId !== input.sourceOperationId ||
          existing.userId !== input.userId
        ) {
          return yield* new ModelOperationRestartConflict({
            operationId: input.restartedOperationId,
          });
        }
        return { _tag: "Duplicate", operationId: input.restartedOperationId } as const;
      }

      if (source.status !== "outcome_unknown") {
        return yield* new ModelOperationRestartDenied({ reason: "source_not_outcome_unknown" });
      }
      const [lineage] = yield* sql<{ readonly restartCount: unknown }>`
        SELECT COUNT(*)::int AS "restartCount"
        FROM model_operations
        WHERE root_operation_id = ${source.rootOperationId}
          AND restarted_from_operation_id IS NOT NULL
      `;
      const restartCount = yield* Schema.decodeUnknown(
        Schema.Struct({ restartCount: Schema.Int.pipe(Schema.nonNegative()) }),
      )(lineage);
      if (restartCount.restartCount >= source.explicitRestartLimit) {
        return yield* new ModelOperationRestartDenied({ reason: "restart_limit_exhausted" });
      }

      const [period] = yield* sql<{ readonly periodStart: unknown }>`
        SELECT date_trunc('month', CURRENT_DATE)::date::text AS "periodStart"
      `;
      const { periodStart } = yield* Schema.decodeUnknown(
        Schema.Struct({ periodStart: Schema.String }),
      )(period);
      const reservation = parseMicroUsd(source.reservedCostMicroUsd);
      if (source.provider === "openai" && reservation > 0n) {
        yield* sql`
          INSERT INTO model_budget_accounts (
            scope_type,
            scope_key,
            period_start,
            ceiling_micro_usd
          )
          VALUES
            (
              'environment',
              ${source.budgetEnvironmentKey},
              ${periodStart}::date,
              ${source.environmentMonthlyCeilingMicroUsd}
            ),
            (
              'user',
              ${source.userId},
              ${periodStart}::date,
              ${source.userMonthlyCeilingMicroUsd}
            )
          ON CONFLICT (scope_type, scope_key, period_start) DO NOTHING
        `;
        const budgetRows = yield* sql<Record<string, unknown>>`
          SELECT
            scope_type AS "scopeType",
            scope_key AS "scopeKey",
            ceiling_micro_usd::text AS "ceilingMicroUsd",
            reserved_micro_usd::text AS "reservedMicroUsd",
            settled_micro_usd::text AS "settledMicroUsd",
            kill_switch AS "killSwitch"
          FROM model_budget_accounts
          WHERE period_start = ${periodStart}::date
            AND (
              (scope_type = 'environment' AND scope_key = ${source.budgetEnvironmentKey})
              OR (scope_type = 'user' AND scope_key = ${source.userId})
            )
          ORDER BY scope_type, scope_key
          FOR UPDATE
        `;
        const budgets = yield* Schema.decodeUnknown(Schema.Array(BudgetRow))(budgetRows);
        const environmentBudget = budgets.find((budget) => budget.scopeType === "environment");
        const userBudget = budgets.find((budget) => budget.scopeType === "user");
        if (environmentBudget?.killSwitch === true) {
          return yield* new ModelOperationKillSwitchEngaged({
            budgetKey: source.budgetEnvironmentKey,
          });
        }
        if (
          environmentBudget === undefined ||
          parseMicroUsd(environmentBudget.reservedMicroUsd) +
            parseMicroUsd(environmentBudget.settledMicroUsd) +
            reservation >
            parseMicroUsd(environmentBudget.ceilingMicroUsd)
        ) {
          return yield* new ModelOperationBudgetExceeded({ scope: "environment_month" });
        }
        if (
          userBudget === undefined ||
          parseMicroUsd(userBudget.reservedMicroUsd) +
            parseMicroUsd(userBudget.settledMicroUsd) +
            reservation >
            parseMicroUsd(userBudget.ceilingMicroUsd)
        ) {
          return yield* new ModelOperationBudgetExceeded({ scope: "user_month" });
        }
        yield* sql`
          UPDATE model_budget_accounts
          SET
            reserved_micro_usd = reserved_micro_usd + ${reservation.toString()},
            updated_at = CURRENT_TIMESTAMP
          WHERE period_start = ${periodStart}::date
            AND (
              (scope_type = 'environment' AND scope_key = ${source.budgetEnvironmentKey})
              OR (scope_type = 'user' AND scope_key = ${source.userId})
            )
        `;
        yield* recordBudgetThresholds({
          environmentBudgetKey: source.budgetEnvironmentKey,
          periodStart,
          userId: source.userId,
        });
      }

      const inserted = yield* sql<{ readonly operationId: unknown }>`
        INSERT INTO model_operations (
          id,
          root_operation_id,
          restarted_from_operation_id,
          user_id,
          operation_name,
          operation_version,
          retry_policy_version,
          prompt_version,
          schema_version,
          input_digest,
          canonical_input,
          provider,
          model,
          deadline_at,
          maximum_http_dispatches,
          maximum_input_utf8_bytes,
          maximum_potentially_billable_attempts,
          transient_rate_limit_retry_limit,
          explicit_restart_limit,
          output_token_limit,
          provider_timeout_milliseconds,
          total_deadline_milliseconds,
          daily_dispatch_limit,
          budget_environment_key,
          budget_period_start,
          environment_monthly_ceiling_micro_usd,
          user_monthly_ceiling_micro_usd,
          reserved_cost_micro_usd
        )
        SELECT
          ${input.restartedOperationId},
          source.root_operation_id,
          source.id,
          source.user_id,
          source.operation_name,
          source.operation_version,
          source.retry_policy_version,
          source.prompt_version,
          source.schema_version,
          source.input_digest,
          source.canonical_input,
          source.provider,
          source.model,
          CURRENT_TIMESTAMP + (source.total_deadline_milliseconds * INTERVAL '1 millisecond'),
          source.maximum_http_dispatches,
          source.maximum_input_utf8_bytes,
          source.maximum_potentially_billable_attempts,
          source.transient_rate_limit_retry_limit,
          source.explicit_restart_limit,
          source.output_token_limit,
          source.provider_timeout_milliseconds,
          source.total_deadline_milliseconds,
          source.daily_dispatch_limit,
          source.budget_environment_key,
          ${periodStart}::date,
          source.environment_monthly_ceiling_micro_usd,
          source.user_monthly_ceiling_micro_usd,
          ${reservation.toString()}
        FROM model_operations AS source
        WHERE source.id = ${input.sourceOperationId}
        RETURNING id AS "operationId"
      `;
      const restarted = yield* Schema.decodeUnknown(InsertedOperationRow)(inserted[0]);
      return { _tag: "Restarted", operationId: restarted.operationId } as const;
    });

    return yield* sql.withTransaction(transaction).pipe(
      Effect.tapError((cause) =>
        cause instanceof ModelOperationBudgetExceeded ||
        cause instanceof ModelOperationKillSwitchEngaged ||
        cause instanceof ModelOperationNotFound ||
        cause instanceof ModelOperationRestartConflict ||
        cause instanceof ModelOperationRestartDenied
          ? Effect.void
          : observePersistenceFailure("restart", cause),
      ),
      Effect.mapError((cause) =>
        cause instanceof ModelOperationBudgetExceeded ||
        cause instanceof ModelOperationKillSwitchEngaged ||
        cause instanceof ModelOperationNotFound ||
        cause instanceof ModelOperationRestartConflict ||
        cause instanceof ModelOperationRestartDenied
          ? cause
          : persistenceUnavailable("restart"),
      ),
    );
  });

  return ModelOperationStore.of({ claim, complete, prepare, restart });
});

/** Dependency-preserving model-operation Layer for an existing PostgreSQL client. */
export const layerWithoutDependencies = Layer.effect(ModelOperationStore, make);

/** Construct an invocation-scoped PostgreSQL model-operation store. */
export function makePostgresModelOperationStoreLayer(databaseUrl: Redacted.Redacted<string>) {
  const clientLayer = PgClient.layer({
    url: databaseUrl,
    applicationName: "xpensego-model-operations",
    connectTimeout: "5 seconds",
    idleTimeout: "1 second",
    maxConnections: 4,
  }).pipe(
    Layer.tapError((cause) => observePersistenceFailure("claim", cause)),
    Layer.mapError(() => persistenceUnavailable("claim")),
  );

  return layerWithoutDependencies.pipe(Layer.provide(clientLayer));
}
