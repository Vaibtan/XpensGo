import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

/** Add durable model-operation, attempt, dispatch-limit, and spend-reservation state. */
export const modelOperationsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE model_budget_accounts (
      scope_type TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      period_start DATE NOT NULL,
      ceiling_micro_usd BIGINT NOT NULL,
      reserved_micro_usd BIGINT NOT NULL DEFAULT 0,
      settled_micro_usd BIGINT NOT NULL DEFAULT 0,
      kill_switch BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (scope_type, scope_key, period_start),
      CONSTRAINT model_budget_accounts_scope_supported
        CHECK (scope_type IN ('environment', 'user')),
      CONSTRAINT model_budget_accounts_key_nonempty
        CHECK (char_length(scope_key) BETWEEN 1 AND 128),
      CONSTRAINT model_budget_accounts_amounts_nonnegative
        CHECK (
          ceiling_micro_usd >= 0
          AND reserved_micro_usd >= 0
          AND settled_micro_usd >= 0
        )
    )
  `;

  yield* sql`
    CREATE TABLE model_budget_alert_events (
      scope_type TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      period_start DATE NOT NULL,
      threshold_percent INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (scope_type, scope_key, period_start, threshold_percent),
      CONSTRAINT model_budget_alert_events_budget_fk
        FOREIGN KEY (scope_type, scope_key, period_start)
        REFERENCES model_budget_accounts (scope_type, scope_key, period_start)
        ON DELETE CASCADE,
      CONSTRAINT model_budget_alert_events_threshold_supported
        CHECK (threshold_percent IN (50, 80, 90, 100))
    )
  `;

  yield* sql`
    CREATE TABLE model_operations (
      id UUID PRIMARY KEY,
      root_operation_id UUID NOT NULL,
      restarted_from_operation_id UUID,
      user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
      operation_name TEXT NOT NULL,
      operation_version INTEGER NOT NULL,
      retry_policy_version INTEGER NOT NULL,
      prompt_version INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      input_digest CHAR(64) NOT NULL,
      canonical_input TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'prepared',
      completion_disposition TEXT,
      observed_failure TEXT,
      retry_plan TEXT NOT NULL DEFAULT 'none',
      retry_not_before TIMESTAMPTZ,
      deadline_at TIMESTAMPTZ NOT NULL,
      current_attempt_id UUID,
      current_lease_until TIMESTAMPTZ,
      maximum_http_dispatches INTEGER NOT NULL,
      maximum_input_utf8_bytes INTEGER NOT NULL,
      maximum_potentially_billable_attempts INTEGER NOT NULL,
      transient_rate_limit_retry_limit INTEGER NOT NULL,
      transient_rate_limit_retries_used INTEGER NOT NULL DEFAULT 0,
      explicit_restart_limit INTEGER NOT NULL,
      http_dispatch_count INTEGER NOT NULL DEFAULT 0,
      output_token_limit INTEGER NOT NULL,
      provider_timeout_milliseconds INTEGER NOT NULL,
      total_deadline_milliseconds INTEGER NOT NULL,
      daily_dispatch_limit INTEGER NOT NULL,
      budget_environment_key TEXT NOT NULL,
      budget_period_start DATE NOT NULL,
      environment_monthly_ceiling_micro_usd BIGINT NOT NULL,
      user_monthly_ceiling_micro_usd BIGINT NOT NULL,
      reserved_cost_micro_usd BIGINT NOT NULL,
      settled_cost_micro_usd BIGINT NOT NULL DEFAULT 0,
      result_json JSONB,
      provider_request_id TEXT,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMPTZ,
      CONSTRAINT model_operations_root_fk
        FOREIGN KEY (root_operation_id) REFERENCES model_operations (id) DEFERRABLE,
      CONSTRAINT model_operations_restart_source_fk
        FOREIGN KEY (restarted_from_operation_id) REFERENCES model_operations (id) DEFERRABLE,
      CONSTRAINT model_operations_name_supported
        CHECK (
          operation_name IN (
            'transaction.extract.v1',
            'transaction.extract_many.v1',
            'query.slots.v1'
          )
        ),
      CONSTRAINT model_operations_input_digest_sha256
        CHECK (input_digest ~ '^[a-f0-9]{64}$'),
      CONSTRAINT model_operations_input_bounded
        CHECK (char_length(canonical_input) BETWEEN 1 AND 32768),
      CONSTRAINT model_operations_provider_supported
        CHECK (provider IN ('deterministic', 'openai')),
      CONSTRAINT model_operations_status_supported
        CHECK (
          status IN (
            'prepared',
            'dispatched',
            'retry_scheduled',
            'succeeded',
            'explicitly_rejected',
            'invalid_output',
            'outcome_unknown'
          )
        ),
      CONSTRAINT model_operations_disposition_supported
        CHECK (
          completion_disposition IS NULL
          OR completion_disposition IN (
            'succeeded',
            'explicitly_rejected',
            'invalid_output',
            'outcome_unknown'
          )
        ),
      CONSTRAINT model_operations_retry_plan_supported
        CHECK (retry_plan IN ('none', 'schedule_transient_429')),
      CONSTRAINT model_operations_budget_key_supported
        CHECK (budget_environment_key IN ('development_staging', 'alpha')),
      CONSTRAINT model_operations_counts_valid
        CHECK (
          operation_version > 0
          AND retry_policy_version > 0
          AND prompt_version > 0
          AND schema_version > 0
          AND maximum_http_dispatches > 0
          AND maximum_input_utf8_bytes > 0
          AND maximum_potentially_billable_attempts > 0
          AND transient_rate_limit_retry_limit >= 0
          AND transient_rate_limit_retries_used >= 0
          AND transient_rate_limit_retries_used <= transient_rate_limit_retry_limit
          AND explicit_restart_limit >= 0
          AND http_dispatch_count >= 0
          AND http_dispatch_count <= maximum_http_dispatches
          AND output_token_limit > 0
          AND provider_timeout_milliseconds > 0
          AND total_deadline_milliseconds > 0
          AND daily_dispatch_limit > 0
        ),
      CONSTRAINT model_operations_costs_nonnegative
        CHECK (
          environment_monthly_ceiling_micro_usd >= 0
          AND user_monthly_ceiling_micro_usd >= 0
          AND reserved_cost_micro_usd >= 0
          AND settled_cost_micro_usd >= 0
        ),
      CONSTRAINT model_operations_retry_schedule_complete
        CHECK (
          (status = 'retry_scheduled' AND retry_plan = 'schedule_transient_429'
            AND retry_not_before IS NOT NULL)
          OR (status <> 'retry_scheduled' AND retry_plan = 'none'
            AND retry_not_before IS NULL)
        ),
      CONSTRAINT model_operations_claim_complete
        CHECK (
          (status = 'dispatched' AND current_attempt_id IS NOT NULL
            AND current_lease_until IS NOT NULL)
          OR (status <> 'dispatched' AND current_attempt_id IS NULL
            AND current_lease_until IS NULL)
        ),
      CONSTRAINT model_operations_terminal_complete
        CHECK (
          (
            status IN ('prepared', 'dispatched')
            AND completion_disposition IS NULL
            AND completed_at IS NULL
            AND result_json IS NULL
          )
          OR (
            status = 'retry_scheduled'
            AND completion_disposition = 'explicitly_rejected'
            AND completed_at IS NULL
            AND result_json IS NULL
          )
          OR (
            status = 'succeeded'
            AND completion_disposition = 'succeeded'
            AND completed_at IS NOT NULL
            AND result_json IS NOT NULL
          )
          OR (
            status IN ('explicitly_rejected', 'invalid_output', 'outcome_unknown')
            AND completion_disposition = status
            AND completed_at IS NOT NULL
            AND result_json IS NULL
          )
        )
    )
  `;

  yield* sql`
    CREATE TABLE model_attempts (
      id UUID PRIMARY KEY,
      operation_id UUID NOT NULL REFERENCES model_operations (id) ON DELETE RESTRICT,
      attempt_ordinal INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'dispatched',
      leased_until TIMESTAMPTZ NOT NULL,
      completion_disposition TEXT,
      observed_failure TEXT,
      retry_plan TEXT NOT NULL DEFAULT 'none',
      provider_request_id TEXT,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      cost_micro_usd BIGINT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMPTZ,
      CONSTRAINT model_attempts_ordinal_positive CHECK (attempt_ordinal > 0),
      CONSTRAINT model_attempts_ordinal_unique UNIQUE (operation_id, attempt_ordinal),
      CONSTRAINT model_attempts_status_supported
        CHECK (status IN ('dispatched', 'completed')),
      CONSTRAINT model_attempts_disposition_supported
        CHECK (
          completion_disposition IS NULL
          OR completion_disposition IN (
            'succeeded',
            'explicitly_rejected',
            'invalid_output',
            'outcome_unknown'
          )
        ),
      CONSTRAINT model_attempts_retry_plan_supported
        CHECK (retry_plan IN ('none', 'schedule_transient_429')),
      CONSTRAINT model_attempts_usage_nonnegative
        CHECK (
          (input_tokens IS NULL OR input_tokens >= 0)
          AND (cached_input_tokens IS NULL OR cached_input_tokens >= 0)
          AND (output_tokens IS NULL OR output_tokens >= 0)
          AND (reasoning_tokens IS NULL OR reasoning_tokens >= 0)
          AND (cost_micro_usd IS NULL OR cost_micro_usd >= 0)
        ),
      CONSTRAINT model_attempts_completion_complete
        CHECK (
          (status = 'dispatched' AND completion_disposition IS NULL AND completed_at IS NULL)
          OR (status = 'completed' AND completion_disposition IS NOT NULL
            AND completed_at IS NOT NULL)
        )
    )
  `;

  yield* sql`
    ALTER TABLE model_operations
      ADD CONSTRAINT model_operations_current_attempt_fk
      FOREIGN KEY (current_attempt_id) REFERENCES model_attempts (id) DEFERRABLE
  `;

  yield* sql`
    CREATE TABLE model_daily_dispatch_counters (
      user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      dispatch_date DATE NOT NULL,
      dispatch_count INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, dispatch_date),
      CONSTRAINT model_daily_dispatch_counters_count_positive CHECK (dispatch_count > 0)
    )
  `;

  yield* sql`
    CREATE INDEX model_operations_recoverable_idx
      ON model_operations (current_lease_until, id)
      WHERE status = 'dispatched'
  `;

  yield* sql`
    CREATE INDEX model_operations_retry_ready_idx
      ON model_operations (retry_not_before, id)
      WHERE status = 'retry_scheduled'
  `;

  yield* sql`
    GRANT SELECT ON model_budget_accounts, model_budget_alert_events,
      model_operations, model_attempts,
      model_daily_dispatch_counters TO xpensego_runtime
  `;

  yield* sql`
    GRANT INSERT ON model_budget_accounts, model_budget_alert_events,
      model_operations, model_attempts,
      model_daily_dispatch_counters TO xpensego_runtime
  `;

  yield* sql`
    GRANT UPDATE (reserved_micro_usd, settled_micro_usd, kill_switch, updated_at)
      ON model_budget_accounts TO xpensego_runtime
  `;

  yield* sql`
    GRANT UPDATE (
      status,
      completion_disposition,
      observed_failure,
      retry_plan,
      retry_not_before,
      current_attempt_id,
      current_lease_until,
      transient_rate_limit_retries_used,
      http_dispatch_count,
      reserved_cost_micro_usd,
      settled_cost_micro_usd,
      result_json,
      provider_request_id,
      input_tokens,
      cached_input_tokens,
      output_tokens,
      reasoning_tokens,
      updated_at,
      completed_at
    ) ON model_operations TO xpensego_runtime
  `;

  yield* sql`
    GRANT UPDATE (
      status,
      completion_disposition,
      observed_failure,
      retry_plan,
      provider_request_id,
      input_tokens,
      cached_input_tokens,
      output_tokens,
      reasoning_tokens,
      cost_micro_usd,
      completed_at
    ) ON model_attempts TO xpensego_runtime
  `;

  yield* sql`
    GRANT UPDATE (dispatch_count, updated_at)
      ON model_daily_dispatch_counters TO xpensego_runtime
  `;
});
