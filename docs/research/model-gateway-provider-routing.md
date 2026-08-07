# Model gateway provider and routing policy

**Issue:** [#12](https://github.com/Vaibtan/XpensGo/issues/12)
**Researched:** 2026-08-03
**Status:** policy accepted in [#13](https://github.com/Vaibtan/XpensGo/issues/13), recorded by [ADR 0005](../adr/0005-effect-openai-model-gateway.md), and queued for proof in [#19](https://github.com/Vaibtan/XpensGo/issues/19); no provider package, credential, or production route has been changed

## Decision summary

Adopt an application-owned **Effect Model Gateway** and, subject to the implementation gates below, use the following provider adapter:

1. **OpenAI API through `ai@7.0.48` core plus `@ai-sdk/openai@4.0.27`.** The Vercel AI SDK is an adapter implementation detail only. Xpensego does not use Vercel hosting, Vercel AI Gateway, AI SDK UI/React packages, an agent abstraction, or model-string routing.
2. **`gpt-5.4-nano-2026-03-17` is the only initially enabled model.** It handles single- or small-multiple transaction extraction, natural-language intent classification, and query-slot filling. OpenAI describes GPT-5.4 nano as intended for classification and data extraction; the snapshot supports Structured Outputs and currently costs $0.20 per million input tokens and $1.25 per million output tokens. [OpenAI GPT-5.4 nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano)
3. **`gpt-5.4-mini-2026-03-17` is an approval-gated second model, not a runtime fallback.** It may be enabled only for bounded, deterministically classified complex import chunks after the evaluation corpus proves a material quality gain. It currently costs $0.75 per million input tokens and $4.50 per million output tokens and supports Structured Outputs. [OpenAI GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
4. **Effect Schema remains the sole application contract authority.** Generate a provider-safe JSON Schema from the Effect Schema, give that generated schema to AI SDK `Output.object`, and decode the returned value again through the original Effect Schema before persistence. There are no handwritten Zod contracts.
5. **Disable SDK retries (`maxRetries: 0`) and own reliability in the durable application operation.** The operation registry supplies a persisted, request-tightened retry policy. Only an explicit transient rate-limit rejection may be eligible, and the number and delay depend on the operation; a timeout, lost connection, indeterminate response, or server failure after dispatch is never automatically repurchased.
6. **Development is deterministic by default.** Provider-backed staging/evaluation has a $1 monthly ceiling. The controlled 10–15-user alpha has an atomic $5 monthly application ceiling, with the global model kill switch engaged before another reservation can exceed it. These are product limits, not estimates of a provider's billing guarantee.
7. **Do not send real financial contents yet.** OpenAI says API data is not used for training unless the customer opts in, but default abuse-monitoring logs may contain prompts and responses and are retained for up to 30 days. Real data remains blocked until the invite-readiness privacy notice, consent, retention decision, processor terms, deletion handling, and access controls are approved. Set `store: false`; that avoids optional Responses API application state but does not remove default abuse-monitoring retention. [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)

This recommendation selects one provider because Xpensego needs provider-backed evidence, not speculative portability through several installed providers. The application seam preserves a later migration path without paying the complexity, supply-chain, privacy, and testing cost of dormant fallbacks.

## Evidence labels

- **Documented fact** means a linked first-party source makes the claim.
- **Inference** means the sources support the inputs, but Xpensego still needs a Workerd or provider-backed proof.
- **Recommendation** identifies the selected policy or a future reconsideration trigger; implementation claims still require the stated proof gates.

This research note is non-authoritative rationale and point-in-time evidence. Issue #13 approved the provider/adapter, initial routing, structured-output authority, reliability policy, and budget/kill-switch/reconsideration controls. [ADR 0005](../adr/0005-effect-openai-model-gateway.md) records why; the Specification owns enforceable behavior; the Checklist and [issue #19](https://github.com/Vaibtan/XpensGo/issues/19) own delivery and proof. Real financial data remains independently blocked by the invite-readiness privacy gate.

## Required architecture

```text
Domain / application operation
  -> Effect ModelGateway service
       operation id + operation version
       prompt version + Effect output Schema
       input digest + idempotency key
       token, money, timeout and attempt budgets
       -> operation registry selects one explicit route
            deterministic Layer (tests and default local development)
            OR OpenAI Layer (staging / approved alpha)
                 -> AI SDK core generateText
                      -> @ai-sdk/openai
                           -> pinned OpenAI model snapshot
       <- typed success / rejected / unavailable / outcome_unknown
  -> Effect Schema boundary validation
  -> deterministic authorization, money, date and query logic
  -> atomic persistence of result, usage, cost and operation state
```

The model never receives or chooses a `UserId`, `LedgerId`, SQL statement, database capability, category mutation, idempotency key, or provider route. The application resolves actor scope before model work, then deterministic code decides whether a validated suggestion can create a transaction or must become a Review Item.

## Provider comparison

All four options have a credible Cloudflare Workers invocation path. Workers can make outbound HTTPS requests with the standard Fetch API, while Workers AI additionally exposes a native binding. This establishes a plausible runtime path, not proof that the selected package graph bundles under Xpensego's exact Wrangler configuration; issue #19 keeps the deployed Workerd spike as a gate. [Cloudflare Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/), [Workers AI overview](https://developers.cloudflare.com/workers-ai/)

Prices below are point-in-time evidence from 2026-08-03 and must not be copied into the Specification as durable architecture.

| Provider and candidate                                                                     | Structured output                                                                                                                                                                                                                                                                                                        | Price at research time                                                                                                                                                                                                                                    | Data handling relevant to financial contents                                                                                                                                                                                                                                                                                                                                                                           | Workers fit and decision                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI: GPT-5.4 nano; mini only after an eval gate**                                     | OpenAI says Structured Outputs ensures responses adhere to the supplied JSON Schema; both selected snapshots list the feature. Refusals and truncation still require typed handling, and Effect revalidates semantic refinements. [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) | Nano: $0.20 input / $1.25 output per million tokens. Mini: $0.75 / $4.50. [Nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano), [mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini)                                          | API data is not used for training unless opted in. Default abuse-monitoring retention is up to 30 days and may contain prompts/responses; ZDR requires approval. [Data controls](https://developers.openai.com/api/docs/guides/your-data)                                                                                                                                                                              | Official AI SDK provider, explicit model snapshots, strongest cost/strict-output fit of the compared hosted options. **Select with the privacy and deployed-bundle gates.**                                                                                                   |
| **Google Gemini: Gemini 3.1 Flash-Lite**                                                   | Gemini structured output supports a documented subset of JSON Schema, so the operation schema still needs compatibility tests and Effect validation. [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output)                                                                                 | $0.25 input / $1.50 output per million tokens on paid standard service. [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)                                                                                                                   | Free/unpaid use may be used to improve Google products and may be human reviewed; it must not receive sensitive data. Paid service is not used for product improvement, but prompts/context/outputs are retained for 55 days for abuse monitoring. [Gemini terms](https://ai.google.dev/gemini-api/terms), [abuse monitoring](https://ai.google.dev/gemini-api/docs/usage-policies)                                    | Similar price and a direct HTTPS route, but longer standard retention and no measured quality advantage for this corpus. **Do not install.**                                                                                                                                  |
| **Anthropic: Claude Haiku 4.5**                                                            | Anthropic documents constrained, schema-compliant JSON outputs for Haiku 4.5. Refusal and output-limit cases can still violate the schema and must be handled. [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)                                                  | $1 input / $5 output per million tokens. [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)                                                                                                                                    | Standard API inputs/outputs are deleted within 30 days. Anthropic additionally documents prompts/responses for structured output as ZDR, with only the schema cached for up to 24 hours. [Standard retention](https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [structured-output retention](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) | Strongest documented default path for this operation's content retention, but materially higher token price and no Xpensego corpus advantage has been measured. **Do not install; reopen if the privacy owner rejects OpenAI's default retention or evals justify the cost.** |
| **Cloudflare Workers AI: Llama 3.3 70B FP8 Fast as the most plausible current comparison** | Workers AI accepts JSON Schema, but Cloudflare explicitly says it cannot guarantee the model follows the requested schema and may return `JSON Mode couldn't be met`. [Workers AI JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)                                                           | Model price is currently $0.293 input / $2.253 output per million tokens. Workers AI includes 10,000 Neurons daily at no charge; exceeding it requires Workers Paid. [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) | Cloudflare says customer content is not used to train models or improve Cloudflare/third-party services without explicit consent, and is stored only when the customer uses a storage service with it. Third-party model license terms still apply. [Workers AI data use](https://developers.cloudflare.com/workers-ai/platform/data-usage/)                                                                           | Best native Workers fit and attractive privacy/cost profile, but its documented schema guarantee is weaker than this mutation boundary requires. **Reject for transaction extraction; reconsider only after strict-output support and corpus results change.**                |

### Comparison conclusion

The decision is not that OpenAI is universally better. It is the smallest current choice that combines an official AI SDK adapter, a low-cost extraction-specific snapshot, model-version pinning, and a first-party strict-output contract. Anthropic is the privacy-triggered reconsideration candidate; Workers AI is the platform-native reconsideration candidate. Neither is installed in advance.

## Operation-level routing

Routing is static application policy keyed by a versioned operation. The caller cannot submit a provider or model name, and a provider error never causes silent cross-provider or cross-model fallback.

Each enabled operation receives a versioned retry ceiling from the registry. The request may tighten that ceiling for its remaining deadline, budget, cancellation state, size, prior attempts, and provider `Retry-After`, but it can never raise it. Only an explicit, known-rejected 429 is eligible for automatic redispatch; every ambiguous response ends that attempt without another automatic purchase. The approved initial operation-specific bounds are defined in the reliability section and remain subject to staging measurement.

| Operation                                             | Deterministic work before and after the model                                                                                                                                                                  | Initial route and hard limits                                                                                                            | Escalation policy                                                                                                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transaction.extract.v1`                              | Normalize whitespace; detect known bank/UPI templates; preserve the Source Record; validate currency, decimal scale, direction, date/timezone and category; create a Review Item for ambiguity.                | Nano snapshot; at most 1,500 input and 256 output tokens.                                                                                | No automatic mini escalation. A missing/ambiguous amount receives the one product clarification; other uncertainty becomes review.                                         |
| `transaction.extract_many.v1`                         | Split obvious records and CSV rows deterministically, enforce row/size limits, detect duplicates, and isolate malformed rows before model work.                                                                | Nano for at most five pasted records; at most 7,500 input and 1,280 output tokens; each result is independently validated and persisted. | A future `import.chunk.extract.v1` may use mini for a bounded chunk only when a deterministic complexity predicate and the mini eval gate both pass. No provider fallback. |
| `query.slots.v1`                                      | Authenticate and inject ledger scope; enumerate supported query classes; validate dates, pagination and enum slots; execute only application-owned query functions; calculate all money in deterministic code. | Nano snapshot; at most 1,200 input and 192 output tokens. The model sees the question and schema, not ledger rows.                       | Unsupported or ambiguous intent asks a focused question. It never generates SQL.                                                                                           |
| `import.chunk.extract.v1` (later, disabled initially) | Quarantine/scan, content-validate, parse known columns, split chunks, deduplicate, and reconcile row counts deterministically.                                                                                 | Mini snapshot; at most 6,000 input and 1,500 output tokens; route disabled until explicitly approved.                                    | Enable only if it reduces critical extraction errors by at least 30% relative to nano on complex-import fixtures, without violating the monthly ceiling or latency gate.   |
| `answer.explain.v1` (later, optional)                 | Execute an authorized structured query and calculate totals first; expose only the minimum bounded aggregate needed for wording.                                                                               | Disabled for initial query delivery; use deterministic response templates.                                                               | Enable nano only if user testing shows templates are insufficient and privacy approval covers the bounded aggregate.                                                       |

The per-call ceiling is a safety maximum, not a target. Prompts must remain small and versioned; import size is controlled by chunking rather than a model's large context window.

## Structured-output contract

Effect Schema owns both runtime semantics and the TypeScript output type. The provider adapter should:

1. take the operation's Effect Schema and generate JSON Schema with Effect's JSON Schema support;
2. reject at build/test time any operation schema that cannot be represented by OpenAI's supported strict subset;
3. pass the generated value through AI SDK's `jsonSchema(...)` into `Output.object(...)`, never write a parallel Zod schema;
4. run the returned unknown value through `Schema.decodeUnknown` again, including branded money/date/enums and excess-property rejection;
5. persist only a successful decoded result together with operation, prompt, schema, adapter and model versions; and
6. treat refusal, truncation, missing output, JSON/schema mismatch, and unsupported schema as distinct tagged errors.

AI SDK documents `Output.object` for schema-constrained output, `jsonSchema` as the alternative for other validation libraries, result usage metadata, explicit timeouts, an abort signal, and configurable retries. Its default retry count is two, which is why Xpensego must explicitly set `maxRetries: 0`. [AI SDK `generateText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text), [AI SDK `jsonSchema`](https://ai-sdk.dev/docs/reference/ai-sdk-core/json-schema)

Strict JSON shape does not make extracted financial facts true. Amount, direction, currency, dates, counterparty, duplicates and category remain application-validated suggestions. The schema should make uncertainty explicit with required nullable fields and reason codes rather than invite silent invention through optional keys.

## Vercel AI SDK decision

### Recommendation

Use AI SDK core inside `packages/adapters` only if the Workerd spike passes. The Effect service and operation registry must not expose AI SDK types. Import only the non-streaming primitives required for this slice (`generateText`, `Output`, and `jsonSchema`) plus `createOpenAI`/the explicit Responses model constructor from `@ai-sdk/openai`.

The SDK is useful here because it already normalizes structured output, usage, finish reasons, provider metadata, timeouts and provider errors. The application still owns routing, retry, cost, persistence, telemetry and every domain decision.

### Dependency reality and bloat gate

Current registry inspection produced these exact facts:

- `ai@7.0.48` requires Node 22 or newer, directly depends on `@ai-sdk/gateway@4.0.37`, `@ai-sdk/provider@4.0.4`, and `@ai-sdk/provider-utils@5.0.18`, and declares `zod ^3.25.76 || ^4.1.8` as a peer dependency.
- `@ai-sdk/openai@4.0.27` requires Node 22 or newer, depends on `@ai-sdk/provider@4.0.4` and `@ai-sdk/provider-utils@5.0.18`, and declares the same Zod peer range.
- Xpensego already pins Node 22.23.1, so the Node engine constraint matches the repository.

These values came from the exact-version registry commands recorded below; they are evidence for the pinned candidate graph, not an assertion about future `latest` releases.

Therefore “no Vercel AI Gateway” means **no service, credentials, model-string route, configuration, or runtime use**; it cannot mean the transitive package is absent while using current `ai` core. Likewise, the provider's Zod peer may appear in the resolved dependency graph, but application code must not import it or define a Zod contract. Effect Schema remains the sole contract authority.

Only these two packages may be added as direct model dependencies:

```text
ai@7.0.48
@ai-sdk/openai@4.0.27
```

Do not add `@ai-sdk/react`, an AI SDK agent package/abstraction, `@ai-sdk/gateway` directly, `ai-gateway-provider`, `openai`, another `@ai-sdk/*` provider, or a Cloudflare Workers AI provider. Do not use AI SDK telemetry callbacks to export prompts or results.

Issue #19 must reject and remove the SDK before merge, then implement the same OpenAI call with the existing Effect HTTP client, if the deployed bundle proof shows unsupported Node behavior, meaningful cold-start/size regression, unavoidable gateway initialization, Zod-based contract pressure, or a dependency-audit failure. That is a pre-release adapter choice, not a second installed fallback.

## Reliability, idempotency and typed failure identity

The provider call has no domain side effect, but it can create an unrecoverable billed result. Duplicate calls therefore violate both cost and consistency requirements.

### Durable operation state

Before dispatch, atomically insert or claim a record keyed by the server-issued source/request `operation_id` plus `operation_version`, scoped to the authenticated actor, and reserve its maximum cost. Persist the canonical input digest as an integrity value. Reusing an operation identifier with a different digest is an idempotency conflict; identical content under distinct source/request identifiers remains two legitimate operations. Replays return the persisted success or current terminal/unknown state; they do not call the provider again.

Keep four concepts orthogonal rather than encoding them in one status or error. Lifecycle and completion disposition apply to one provider-attempt identity; its row advances only through guarded compare-and-set transitions, and its identity and completed disposition are immutable. An allowed retry opens the next attempt ordinal under the same operation:

- **Lifecycle:** `prepared | dispatched(lease) | completed(disposition)`.
- **Completion disposition:** `succeeded | explicitly_rejected(reason) | invalid_output(reason) | outcome_unknown(failure_tag)`.
- **Retry plan:** `none | schedule_rate_limit_retry(attempt_ordinal, not_before)`. Rate limiting is an explicit rejection reason plus a retry plan, not a lifecycle state.
- **Observed failure:** one application-owned tagged error carrying only safe evidence. An exhaustive pure classifier maps the error to a completion disposition and retry plan; the error itself does not contain `isRetryable` or choose policy.

Persist a distinct `failure_tag`, `dispatch_certainty`, and attempt record so several failures can share `outcome_unknown` without becoming observationally identical. Use these dispatch-certainty values:

- `not_dispatched`: the durable `dispatched` transition was never committed;
- `possibly_dispatched`: the transition was committed, but the transport cannot prove whether the provider accepted or processed the request;
- `provider_reached`: an HTTP response proves the provider received the request, but does not by itself prove whether work was billed or a usable result existed; and
- `result_received`: a response and body were obtained and can be classified or validated.

### One retry authority, separate delivery retries

Set AI SDK `maxRetries: 0` on every call. The pinned AI SDK v7 source defaults `maxRetries` to two, while its provider error type treats 408, 409, 429, and 5xx responses as retryable by default and its fetch wrapper marks connection failures retryable. Those are useful transport hints, not Xpensego policy. [AI SDK v7 retry preparation](https://github.com/vercel/ai/blob/ai%407.0.48/packages/ai/src/util/prepare-retries.ts), [AI SDK v7 `APICallError`](https://github.com/vercel/ai/blob/ai%407.0.48/packages/provider/src/errors/api-call-error.ts), [AI SDK v7 fetch-error mapping](https://github.com/vercel/ai/blob/ai%407.0.48/packages/provider-utils/src/handle-fetch-error.ts)

The application-owned Model Operation service, backed by its durable store, is the sole authority allowed to purchase another provider attempt. Effect models timeouts and tagged expected errors, but there is no `Effect.retry` or SDK retry around provider dispatch. The service atomically classifies the completed attempt and persists any allowed retry grant before a Queue delay wakes the operation again. No error object or SDK `isRetryable` flag grants a retry. [Effect expected errors](https://effect.website/docs/error-management/expected-errors/)

Cloudflare Queue delivery is a different loop: it delivers each message at least once and may redeliver even when the consumer succeeds. A delivery must atomically claim durable permission before dispatch; active leases, completed attempts, unknown outcomes, duplicate messages, and exhausted budgets acknowledge without calling the provider. `message.attempts`, `message.retry()`/`ack()`, and `max_retries` govern transport delivery only. Xpensego's current Queue ceiling is three configured retries plus DLQ, so tests must observe at most four deliveries including the initial one without allowing those deliveries to reset provider counts, cost, or deadlines. [Cloudflare Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), [Cloudflare Queue batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)

Persist every HTTP dispatch under unique `(operation_id, attempt_ordinal)` and enforce `provider_dispatch_count <= 1 + explicit_rate_limit_retry_grants`, with at most the registry-approved number of grants. An explicit restart from an unknown outcome creates a new `operation_id` linked to the immutable root operation, requires a new reservation, and consumes the lineage's registry-approved `explicit_restart_limit`; the initial policy allows at most one, so the lineage can contain at most two potentially billable operations. If completion persistence fails after dispatch, redelivery observes the live lease and does not call again; lease-expiry recovery later records the unknown outcome. Keep the attempt lease longer than the provider timeout plus the persistence-finalization margin.

### Approved initial operation/request-specific retry bounds

The product owner approved these initial reliability ceilings in issue #13 on 2026-08-06. They are implementation bounds and pre-measurement deadline targets, not validated production SLOs. Every operation persists `retry_policy_version`, `http_dispatch_limit`, `potentially_billable_limit`, `rate_limit_retry_limit`, provider timeout, `deadline_at`, `reserved_cost_limit`, allowed retry tags, and `explicit_restart_limit` before the first dispatch. A request may reduce those bounds for cancellation, size, remaining time, prior attempts, available budget, or provider delay; it cannot raise them.

| Operation                            | HTTP/provider ceiling                                                                                     | Provider / end-to-end automatic deadline | Maximum reservation | Terminal user action                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `transaction.extract.v1`             | At most 2 dispatches only when dispatch 1 is a transient 429; at most 1 potentially billable attempt.     | 3 seconds / 4 seconds from publication   | $0.000620           | One explicit new linked priced operation after `outcome_unknown`; otherwise clarify/review without a ledger mutation. |
| `transaction.extract_many.v1`        | At most 2 dispatches only when dispatch 1 is a transient 429; at most 1 potentially billable attempt.     | 7 seconds / 10 seconds                   | $0.003100           | One explicit new linked priced operation; preserve per-record validation and never silently replay the whole batch.   |
| `query.slots.v1`                     | At most 2 dispatches only when dispatch 1 is a transient 429; at most 1 potentially billable attempt.     | 4 seconds / 6 seconds                    | $0.000480           | Show a retryable query message; user resubmission creates a new operation after an unknown outcome.                   |
| `import.chunk.extract.v1` (disabled) | No approved profile. Enablement must set a measured ceiling and cannot inherit another operation's retry. | To be approved with the import eval      | To be approved      | Explicitly restart only the failed chunk; completed chunks remain fixed.                                              |
| `answer.explain.v1` (disabled)       | No approved profile; deterministic answer templates remain the fallback.                                  | To be approved before enablement         | To be approved      | Return the already-computed deterministic answer template.                                                            |

The 429 retry is allowed only for a parsed transient rate-limit response, not credit, quota, billing, spend-limit, or action-required 429s. `Retry-After` must be valid, no more than one second for these interactive initial operations, and fit the persisted deadline and reservation; otherwise the attempt completes as rate-limited without redispatch. The current Queue `max_batch_timeout` of five seconds cannot meet these publication-to-completion targets, so the implementation spike must prove a model-job batch wait of at most one second—by safely tightening the existing queue or using a latency-sensitive queue—before treating the deadlines as production SLO evidence.

OpenAI recommends honoring `Retry-After`, using exponential backoff with jitter when it is absent, and bounding both attempts and total retry time; it also warns that unsuccessful requests consume rate-limit capacity. It distinguishes transient rate limits from quota, billing, and action-required failures that should not be retried. The approved policy uses those mechanics only for a classified transient 429 and is intentionally stricter than OpenAI's general advice to retry 500/503 responses. [OpenAI rate-limit retry guidance](https://developers.openai.com/api/docs/guides/rate-limits), [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes)

### Error identity and outcome matrix

Every row records the common low-cardinality metric dimensions `environment`, `operation`, registry-enumerated metric-safe operation/retry-policy versions, `failure_tag`, `dispatch_certainty`, completion disposition, provider/model snapshot, attempt ordinal, retry decision, HTTP status family, observed phase, timeout bucket, and Queue delivery-attempt bucket. Registry values have bounded retention; full schema/prompt/policy hashes and build identifiers stay in controlled rows or traces. The matrix names only the additional dimensions specific to each identity.

Pre-dispatch validation, authorization, configuration, and budget failures retain their existing precise application-owned tagged errors. The outer Model Operation classifier maps them to `not_dispatched` and `explicitly_rejected`; it does not collapse them into a generic request-rejected error with a secondary string code.

| Error identity (`failure_tag`)          | Evidence and dispatch certainty                                                                                                                        | Automatic retry authority/budget                                                             | Completion disposition                     | Required metric dimensions                                           | User-facing outcome                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `RequestDeadlineExceededBeforeDispatch` | The request deadline expired before the durable dispatch transition; `not_dispatched`.                                                                 | Only a new user/request operation; never spend a retry after the deadline.                   | `explicitly_rejected`                      | Common + `timeout_scope=pre_dispatch`                                | Ask the user to try again; no provider call was purchased.                                           |
| `ModelSchemaUnsupported`                | The generated schema is outside the provider's approved strict subset; `not_dispatched`. Build/test validation should prevent this in production.      | None; requires an operation/schema-version correction.                                       | `explicitly_rejected`                      | Common + bounded schema-capability code                              | Fail closed as a configuration fault; do not expose provider internals.                              |
| `ModelProviderRateLimited`              | Explicit transient HTTP 429; `provider_reached` and the request is known rejected.                                                                     | The durable service may grant the operation's bounded 429 retry; the error grants nothing.   | `explicitly_rejected`; retry plan separate | Common + provider-delay bucket                                       | “Busy; retrying” only when scheduled; otherwise ask for an explicit retry.                           |
| `ModelProviderQuotaDenied`              | HTTP 429 classified as quota, billing, spend, or action-required; `provider_reached`.                                                                  | None.                                                                                        | `explicitly_rejected`                      | Common + `rate_limit_class=quota_or_action`                          | Service temporarily unavailable; operator action is required.                                        |
| `ModelLocalDeadlineExceeded`            | Xpensego's configured timeout aborts after `dispatched`; `possibly_dispatched`.                                                                        | None, regardless of SDK hint or remaining operation ceiling.                                 | `outcome_unknown`                          | Common + configured-timeout bucket                                   | Result could not be confirmed; no transaction is created; offer the permitted explicit priced retry. |
| `ModelConnectionLost`                   | Fetch/connection failure after `dispatched`; `possibly_dispatched`. Record only `awaiting_response` or `reading_response`, not a guessed socket cause. | None.                                                                                        | `outcome_unknown`                          | Common + observed phase                                              | Same safe unknown-result message; do not imply the provider definitely failed.                       |
| `ModelAttemptLeaseExpired`              | Recovery finds an expired `dispatched` lease without completion; `possibly_dispatched`. It proves missing completion, not a Worker crash.              | None. Recovery records the observation but cannot redispatch.                                | `outcome_unknown`                          | Common + lease-age bucket and `inference=completion_missing`         | Result could not be confirmed; no transaction is created; offer the permitted explicit priced retry. |
| `ModelProviderResponseEmpty`            | An HTTP response arrived but has no usable body; `provider_reached`.                                                                                   | None.                                                                                        | `outcome_unknown`                          | Common + content-type class and provider-request-id presence         | Result could not be recovered; no transaction is created.                                            |
| `ModelProviderResponseMalformed`        | A body arrived but the adapter could not parse JSON or the provider envelope; `provider_reached`.                                                      | None.                                                                                        | `outcome_unknown`                          | Common + bounded parse stage; never response content                 | Result could not be recovered; no transaction is created.                                            |
| `ModelProviderServerError`              | Explicit HTTP 5xx after `dispatched`; `provider_reached`, but processing, billing, and result availability remain unproven.                            | None under Xpensego policy, even though provider/SDK general guidance may call it retryable. | `outcome_unknown`                          | Common; exact status belongs in traces, not metric labels            | Result could not be confirmed; no transaction is created; offer the permitted explicit priced retry. |
| `ModelCallerCancelled`                  | Caller abort observed after `dispatched`; `possibly_dispatched`.                                                                                       | None.                                                                                        | `outcome_unknown`                          | Common + cancellation-source class                                   | Acknowledge cancellation and warn that provider outcome/cost could not be confirmed.                 |
| `ModelProviderRequestRejected`          | Explicit non-429 HTTP 4xx invalid-request or authorization response; `provider_reached`.                                                               | None.                                                                                        | `explicitly_rejected`                      | Common + bounded rejection class                                     | Explain safe remediation without exposing provider internals.                                        |
| `ModelProviderRefused`                  | A parsed provider response explicitly refuses or content-filters the operation; `result_received`.                                                     | None.                                                                                        | `explicitly_rejected`                      | Common + bounded refusal/finish class                                | Explain the refusal safely; do not expose provider internals or persist partial output.              |
| `ModelOutputTruncated`                  | Response received with an incomplete/length finish class; `result_received`.                                                                           | None; increasing the token ceiling requires a reviewed operation-version change.             | `invalid_output`                           | Common + finish, schema, and prompt versions                         | Create review/clarification; never write a partial transaction.                                      |
| `ModelStructuredOutputInvalid`          | Provider protocol parsed, but Effect Schema decoding of the structured output failed; `result_received`.                                               | None.                                                                                        | `invalid_output`                           | Common + bounded decode-reason code and schema version; never output | Create review/clarification; never write undecoded values.                                           |
| `ModelSuggestionRejected`               | Structured output decoded, but deterministic application/domain financial validation rejected the suggestion; `result_received`.                       | None.                                                                                        | `invalid_output`                           | Common + bounded domain-rule code and ruleset version                | Create review/clarification; never write rejected financial values.                                  |

The pinned AI SDK v7 source already gives missing-body and invalid-provider-response errors distinct identities and emits a `TimeoutError` for its configured timeout. Map them immediately into the tags above, and discard/redact response bodies before logging. [AI SDK v7 empty-response error](https://github.com/vercel/ai/blob/ai%407.0.48/packages/provider/src/errors/empty-response-body-error.ts), [AI SDK v7 invalid-response error](https://github.com/vercel/ai/blob/ai%407.0.48/packages/provider/src/errors/invalid-response-data-error.ts), [AI SDK v7 timeout source](https://github.com/vercel/ai/blob/ai%407.0.48/packages/ai/src/util/set-abort-timeout.ts)

A terminated Worker cannot report its own typed error. Cloudflare may cancel unfinished work after the response/disconnect grace period and Workers may be terminated during runtime updates, so `ModelAttemptLeaseExpired` is constructed only by durable recovery rather than being mislabeled `WorkerTerminated`. Queue consumers have a longer documented wall-time limit, but that does not turn termination into a recoverable provider result. [Cloudflare `waitUntil` lifecycle](https://developers.cloudflare.com/workers/runtime-apis/context/), [Cloudflare Worker limits](https://developers.cloudflare.com/workers/platform/limits/)

The provider port exposes distinct Effect `Schema.TaggedError` classes for the observable provider failures; `ModelAttemptLeaseExpired` belongs to durable recovery because the interrupted invocation cannot construct it, while `ModelSuggestionRejected` belongs to the application/domain validation service. Their fields contain only safe, bounded context such as attempt/operation version, provider/model, observed phase, timeout/elapsed duration, bounded status, lease timestamps, or registry-enumerated reason codes. They do not expose SDK types, raw causes, response bodies, headers, retryability, or disposition.

User ids, operation ids, request ids, Worker invocation ids, Queue message ids, prompts, outputs, response bodies, raw headers, exception strings, and financial contents are not metric dimensions; opaque identifiers belong only in access-controlled rows/traces.

Set `X-Client-Request-Id` to the opaque attempt identifier and persist OpenAI's returned `x-request-id` when present. The reviewed OpenAI material documents request identifiers for troubleshooting; it did not establish an idempotent result-retrieval contract for this call. That is an evidence gap, not proof that no private/provider mechanism exists, and it is insufficient to make an unknown attempt safe to retry. [OpenAI error and request diagnostics](https://developers.openai.com/api/docs/guides/error-codes)

A user/operator may explicitly start the operation-permitted new priced operation from `outcome_unknown`. It receives a new operation identifier and reservation linked to the immutable root and consumes the lineage's explicit-restart grant; the original remains unknown. No ledger mutation is created from an unknown attempt.

Issue #13 approved this reliability policy, including the operation ceilings, separate failure taxonomy, user recovery actions, and versioned retry authority, on 2026-08-06. ADR 0005 and the Specification now own the accepted invariants; this section preserves the supporting detail and sources.

## Cost controls for development and the small alpha

The product owner approved these controls in issue #13 on 2026-08-07. The Specification owns the limits and triggers; the price table below remains dated research evidence only.

### Per-operation maximums at current prices

| Route                                 | Maximum input/output | Worst-case token cost per dispatched call |
| ------------------------------------- | -------------------- | ----------------------------------------- |
| Nano single-transaction extraction    | 1,500 / 256          | $0.000620                                 |
| Nano five-transaction extraction      | 7,500 / 1,280        | $0.003100                                 |
| Nano query-slot filling               | 1,200 / 192          | $0.000480                                 |
| Mini import chunk, disabled initially | 6,000 / 1,500        | $0.011250                                 |

These calculations exclude taxes and future price changes. The durable rate card records provider, model snapshot, currency, input/output rates, source date and operation version so historical costs remain explainable.

### Application controls

- Local development uses the deterministic adapter unless a developer explicitly runs a provider evaluation.
- Development/staging provider work has a shared **$1.00 monthly ceiling**.
- The controlled alpha has a **$5.00 monthly ceiling** across actual charges plus worst-case reservations for unknown/in-flight attempts.
- Reserve maximum cost atomically before dispatch; reject the operation when reservation would exceed the environment or per-user allowance. Settle to reported usage on success. Keep the full reservation for `outcome_unknown` because the provider may have billed it.
- Alert at 50% of the monthly ceiling. At 80%, disable mini and nonessential evaluation work. At 90%, notify the product/technical owner. At 100%, the application kill switch rejects every new model dispatch.
- Start the alpha with a per-user allowance of $0.25 per calendar month and a 20-provider-call daily abuse limit. Product-authorized import operations consume their predicted reservation before work begins.
- Configure an OpenAI project budget alert/limit as defense in depth, but treat the PostgreSQL reservation ledger and application kill switch as the synchronous authority.
- Record input/output/reasoning/cached token counts when supplied, computed cost, provider/model/operation versions, latency, finish class and opaque request identifiers. Never record Source Record text, question text, model output, account numbers, counterparty, amount, Telegram identifiers, email, or API keys in telemetry.

### Reopen, upgrade and kill-switch triggers

Reopen provider/model selection when any one occurs:

- a selected snapshot is deprecated, materially changes availability, or its price changes by 20% or more;
- monthly cost per activated alpha user exceeds $0.25 or projected aggregate cost exceeds $5;
- critical-field quality, privacy, Workerd compatibility or latency gates below fail;
- unknown outcomes exceed 1% of dispatched calls or two within one rolling hour;
- mini would be selected for more than 10% of ordinary transaction/query operations;
- provider terms, retention, training, data location or subprocessors materially change; or
- Anthropic's retention advantage or Workers AI's native/strict-output support produces a measured benefit that justifies a migration evaluation.

Immediately engage the global model kill switch on credential compromise, cross-user content exposure, telemetry content leakage, a provider-policy/privacy breach, an unbounded retry/cost loop, or atomic budget-reservation failure.

## Privacy and retention release gate

OpenAI is acceptable for synthetic/redacted provider evaluations under the stated ceiling. It is not yet approved for external users' financial contents.

Before real Source Records are sent, the accepted ADR/Specification and invite-readiness work must record:

1. product-owner and privacy/security-owner acceptance of the standard up-to-30-day abuse-monitoring retention, or documented OpenAI ZDR approval;
2. a current data-processing agreement, subprocessor/location review, and lawful purpose/consent decision for deliberately supplied financial records;
3. a public privacy notice naming the provider and explaining use, retention, deletion limits and that model output is assistive;
4. `store: false`, no background mode, no Files API, no provider conversation state, no prompt/output telemetry, and no opt-in data sharing;
5. a source-minimization policy: send only the specific Source Record or bounded import chunk needed for the operation; and
6. deletion behavior that removes Xpensego-held prompts/results/operation state according to the product lifecycle while honestly disclosing provider retention outside Xpensego's immediate control.

If standard retention is rejected and ZDR is unavailable at the alpha's budget/eligibility level, stop. Do not silently route real data to Gemini free tier, another provider, or Workers AI.

## Deterministic adapter

Create a `DeterministicModelGateway` Layer under test support, implementing the identical application port and tagged outcomes with no network or credentials.

- Address a fixture by operation id/version plus canonical input digest, not raw substring heuristics.
- Fixtures contain only synthetic or irreversibly redacted Source Records already admitted to the evaluation corpus.
- Each fixture specifies model/prompt/schema labels, artificial usage/cost, latency clock advance and, independently, the observed tagged result/error, expected completion disposition, and expected retry plan. A transient 429 is therefore `ModelProviderRateLimited` + `explicitly_rejected` + either `none` or an authorized `schedule_rate_limit_retry`; it is not a top-level outcome. Successful fixtures also provide the exact decoded output.
- Unregistered input fails closed with a typed `FixtureMissing`; it never calls a real provider.
- Scripted sequences prove lease recovery and each operation's persisted 429 retry ceiling. Duplicate/concurrent calls prove one fixture consumption per authorized provider attempt and one persisted result.
- A separate deterministic parser may handle known bank/UPI formats, but it is domain parsing code, not a hidden “AI fallback.”

This adapter makes local development and the full test suite reproducible while preserving the same idempotency, budget and error behavior as production.

## Evaluation and acceptance gates

Use the versioned corpus already required by the Specification. Provider-backed evaluation inputs must be synthetic or irreversibly redacted; real account numbers, names, reference identifiers, amounts copied from a real person, Telegram metadata and emails are prohibited.

Report results by English/Hinglish, bank/UPI/manual text, single/multiple record, debit/credit, relative date, and ambiguous/malformed class. Do not collapse them into one score.

The initial route is releasable only when:

- **100%** of provider responses either decode through the Effect Schema or become an explicit typed non-success;
- **100%** of amount, direction and currency values on mutation-eligible fixtures are exact; no invented amount/date/currency reaches a transaction;
- **100%** of intentionally ambiguous or missing-amount fixtures become clarification/review rather than a silent transaction;
- date resolution is **100%** correct after deterministic timezone validation on the corpus's date-boundary cases;
- counterparty extraction and supported query-intent/slot exact match are at least **95% in every named slice**, not only overall;
- Queue replay, concurrent claims and Worker retry never exceed the persisted operation/request attempt budget; unknown outcomes purchase no automatic retry;
- the nano route's provider-call p95 is at most 2.5 seconds in deployed staging so the five-second Telegram experience budget retains room for queue/database/delivery work;
- measured worst-case reservations and actual usage stay within the rate-card calculations; and
- a secret/log/analytics review finds no financial contents or credentials outside approved persistence.

Evaluate mini against the exact failing complex-import slice. Enable it only if it reduces critical errors by at least 30% relative to nano, introduces zero silent critical-field inventions, stays within $0.02 per bounded chunk and passes the same privacy/latency gates. Otherwise keep it disabled.

## Required implementation proof gates

Approval in issue #13 did not install packages or create runtime evidence. [Issue #19](https://github.com/Vaibtan/XpensGo/issues/19) must prove this disposable vertical slice before the full parser:

1. Pin only `ai@7.0.48` and `@ai-sdk/openai@4.0.27` as direct dependencies; capture the lockfile's transitive gateway and Zod peer impact in dependency review.
2. Bundle and run one Effect-owned structured extraction in local Workerd and deployed staging using Xpensego's actual compatibility date/flags. Prove no Vercel service call, global-scope fetch, unsupported Node API or material bundle/cold-start regression.
3. Prove an Effect Schema can generate the provider JSON Schema and revalidate output without a Zod application schema. Snapshot the generated schema and fail CI on unreviewed drift.
4. Prove `maxRetries: 0`, total timeout, token ceiling, `store: false`, explicit snapshot id, opaque client request id, typed finish/error mapping and content-redacted telemetry from the built Worker.
5. Use provider response headers/usage to persist one successful result and settle its atomic cost reservation; prove Queue duplicate/concurrent execution does not repurchase it.
6. Inject deterministic timeout, network loss, 429, 5xx, missing/malformed response, expired execution lease, refusal, truncation and invalid-output cases. Prove that only a transient 429 receives the operation/request-authorized number of automatic retries and every ambiguous case preserves its typed identity while ending `outcome_unknown` without a ledger mutation.
7. Run the corpus comparison and publish field/slice results, latency, token use and cost without fixture contents.
8. Keep real financial data disabled. Approval of the provider implementation is not approval of the invite-readiness privacy gate.

If the AI SDK dependency/bundle gate fails, remove it before merging and implement the OpenAI adapter using the existing Effect HTTP client. Do not keep both adapters or packages as standby paths.

## Evidence and limits

This research used current first-party documentation and registry/source metadata on 2026-08-03. It did not install a package, call a model, expose an API key, measure model quality, prove Workerd bundling, accept provider terms, or approve real financial data. Price and model availability are snapshots, not contractual guarantees. “Workers-compatible” for external providers is an inference from the Workers Fetch runtime plus web-API-based package design until the deployed spike passes.

Context7 was run before Vercel AI SDK and selected-provider package research as required by the repository instructions. Context7's indexed examples included older major-version material, so the recommendation was verified against current first-party docs and exact npm registry metadata and pins the current v7 packages rather than assuming v6 syntax or dependencies.

### Exact research and validation record

Context7 commands executed; library resolution preceded documentation retrieval:

```powershell
npx ctx7@latest library "Vercel AI SDK" "Should a Cloudflare Workers TypeScript application use the Vercel AI SDK core as an implementation detail inside an Effect-owned model gateway for strict structured output, provider routing, retries, usage metadata, and no React, agent framework, or Vercel hosting?"
npx ctx7@latest docs /vercel/ai "Should a Cloudflare Workers TypeScript application use the Vercel AI SDK core as an implementation detail inside an Effect-owned model gateway for strict structured output, provider routing, retries, usage metadata, and no React, agent framework, or Vercel hosting?"

npx ctx7@latest library "@ai-sdk/openai" "Can @ai-sdk/openai run in Cloudflare Workers with ai core generateText structured output, explicit request timeout and retry control, usage metadata, a fixed OpenAI model snapshot, and an Effect Schema Standard Schema boundary without application Zod schemas?"
npx ctx7@latest docs /vercel/ai "Can @ai-sdk/openai run in Cloudflare Workers with ai core generateText structured output, explicit request timeout and retry control, usage metadata, a fixed OpenAI model snapshot, and an Effect Schema Standard Schema boundary without application Zod schemas?"

npx ctx7@latest library "Vercel AI SDK" "For AI SDK v7 generateText in a Cloudflare Worker, what are the exact maxRetries, timeout, abortSignal, APICallError status/isRetryable/cause semantics, and how should an application distinguish timeout, connection loss, malformed response, and HTTP errors while retaining operation-specific retry policy?"
npx ctx7@latest docs /vercel/ai "For AI SDK v7 generateText in a Cloudflare Worker, what are the exact maxRetries, timeout, abortSignal, APICallError status/isRetryable/cause semantics, and how should an application distinguish timeout, connection loss, malformed response, and HTTP errors while retaining operation-specific retry policy?"

npx ctx7@latest library "OpenAI API" "What current OpenAI API documentation defines request IDs, retryable HTTP errors, rate-limit Retry-After behavior, timeouts, malformed responses, and whether request IDs or Responses API provide an idempotent result-retrieval contract for a dispatched structured-output call?"
npx ctx7@latest docs /websites/developers_openai_api "What current OpenAI API documentation defines request IDs, retryable HTTP errors, rate-limit Retry-After behavior, timeouts, malformed responses, and whether request IDs or Responses API provide an idempotent result-retrieval contract for a dispatched structured-output call?"

npx ctx7@latest library "Cloudflare Workers" "For a Cloudflare Worker and Queue consumer calling an external model API, what are the current documented execution-lifetime, waitUntil, retry, delay, acknowledgment, dead-letter, and at-least-once delivery semantics relevant to distinguishing Worker termination from network timeout and assigning operation-specific retry authority?"
npx ctx7@latest docs /llmstxt/developers_cloudflare_workers_llms-full_txt "For a Cloudflare Worker and Queue consumer calling an external model API, what are the current documented execution-lifetime, waitUntil, retry, delay, acknowledgment, dead-letter, and at-least-once delivery semantics relevant to distinguishing Worker termination from network timeout and assigning operation-specific retry authority?"

npx ctx7@latest library "Effect" "How should Effect TypeScript model distinct tagged error identities, operation-specific retry schedules/budgets, timeout causes, and metrics dimensions without collapsing several failures into one error type?"
npx ctx7@latest docs /effect-ts/effect "How should Effect TypeScript model distinct tagged error identities, operation-specific retry schedules/budgets, timeout causes, and metrics dimensions without collapsing several failures into one error type?"
```

Registry, repository and issue inspection executed:

```powershell
npm view ai version dist-tags --json
npm view @ai-sdk/openai version dist-tags --json
npm view ai@7.0.48 version engines dependencies peerDependencies peerDependenciesMeta --json
npm view @ai-sdk/openai@4.0.27 version engines dependencies peerDependencies peerDependenciesMeta --json
npm view ai@6.0.240 engines dependencies peerDependencies --json
npm view @ai-sdk/openai@3.0.90 engines dependencies peerDependencies peerDependenciesMeta --json
node --version
npm --version
gh issue view 12 --repo Vaibtan/XpensGo --json title,body,labels,state,url
gh issue view 13 --repo Vaibtan/XpensGo --json number,title,body,state,url
gh api "repos/vercel/ai/git/ref/tags/ai%407.0.48"
gh api "repos/vercel/ai/contents/packages/ai/src/util/prepare-retries.ts?ref=ai%407.0.48"
gh api "repos/vercel/ai/contents/packages/ai/src/util/set-abort-timeout.ts?ref=ai%407.0.48"
gh api "repos/vercel/ai/contents/packages/provider/src/errors/api-call-error.ts?ref=ai%407.0.48"
gh api "repos/vercel/ai/contents/packages/provider/src/errors/empty-response-body-error.ts?ref=ai%407.0.48"
gh api "repos/vercel/ai/contents/packages/provider/src/errors/invalid-response-data-error.ts?ref=ai%407.0.48"
gh api "repos/vercel/ai/contents/packages/provider-utils/src/handle-fetch-error.ts?ref=ai%407.0.48"
```

Additional checks performed after writing this note:

- `npm exec prettier -- --check docs/research/model-gateway-provider-routing.md`
- a native Node `fetch` check followed redirects for every unique public source URL in this note;
- `gh issue view` verified the private-repository issue links; and
- `git -c safe.directory=D:/SWE_DEV_NEW/XpensGo status --short` and a path-scoped diff verified that this task modified only this research asset and did not touch the existing `.gitignore`, `.agents/`, or `.playwright-mcp/` changes.
