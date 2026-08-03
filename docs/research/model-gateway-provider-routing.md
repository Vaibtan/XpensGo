# Model gateway provider and routing policy

**Issue:** [#12](https://github.com/Vaibtan/XpensGo/issues/12)
**Researched:** 2026-08-03
**Status:** recommendation ready for product-owner approval in [#13](https://github.com/Vaibtan/XpensGo/issues/13); no provider package, credential, or production route was changed by this research

## Decision summary

Adopt an application-owned **Effect Model Gateway** and, subject to the implementation gates below, use the following provider adapter:

1. **OpenAI API through `ai@7.0.48` core plus `@ai-sdk/openai@4.0.27`.** The Vercel AI SDK is an adapter implementation detail only. Xpensego does not use Vercel hosting, Vercel AI Gateway, AI SDK UI/React packages, an agent abstraction, or model-string routing.
2. **`gpt-5.4-nano-2026-03-17` is the only initially enabled model.** It handles single- or small-multiple transaction extraction, natural-language intent classification, and query-slot filling. OpenAI describes GPT-5.4 nano as intended for classification and data extraction; the snapshot supports Structured Outputs and currently costs $0.20 per million input tokens and $1.25 per million output tokens. [OpenAI GPT-5.4 nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano)
3. **`gpt-5.4-mini-2026-03-17` is an approval-gated second model, not a runtime fallback.** It may be enabled only for bounded, deterministically classified complex import chunks after the evaluation corpus proves a material quality gain. It currently costs $0.75 per million input tokens and $4.50 per million output tokens and supports Structured Outputs. [OpenAI GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
4. **Effect Schema remains the sole application contract authority.** Generate a provider-safe JSON Schema from the Effect Schema, give that generated schema to AI SDK `Output.object`, and decode the returned value again through the original Effect Schema before persistence. There are no handwritten Zod contracts.
5. **Disable SDK retries (`maxRetries: 0`) and own reliability in Effect.** An explicit rate-limit rejection may receive one delayed retry; a timeout, lost connection, indeterminate response, or server failure after dispatch becomes `outcome_unknown` and is never automatically repurchased.
6. **Development is deterministic by default.** Provider-backed staging/evaluation has a $1 monthly ceiling. The controlled 10–15-user alpha has an atomic $5 monthly application ceiling, with the global model kill switch engaged before another reservation can exceed it. These are product limits, not estimates of a provider's billing guarantee.
7. **Do not send real financial contents yet.** OpenAI says API data is not used for training unless the customer opts in, but default abuse-monitoring logs may contain prompts and responses and are retained for up to 30 days. Real data remains blocked until the invite-readiness privacy notice, consent, retention decision, processor terms, deletion handling, and access controls are approved. Set `store: false`; that avoids optional Responses API application state but does not remove default abuse-monitoring retention. [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)

This recommendation selects one provider because Xpensego needs provider-backed evidence, not speculative portability through several installed providers. The application seam preserves a later migration path without paying the complexity, supply-chain, privacy, and testing cost of dormant fallbacks.

## Evidence labels

- **Documented fact** means a linked first-party source makes the claim.
- **Inference** means the sources support the inputs, but Xpensego still needs a Workerd or provider-backed proof.
- **Recommendation** is the policy proposed for approval in issue #13.

This research note is non-authoritative decision input. Until issue #13 accepts a choice, every architecture, policy, limit, and gate below is proposed. Approval must record durable invariants in an ADR and the Specification, resolve the Checklist's open model-decision row, and create a separate implementation-spike ticket for measurable runtime/evaluation evidence. After that synchronization, this note remains rationale and point-in-time evidence rather than a competing specification or delivery plan.

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

All four options have a credible Cloudflare Workers invocation path. Workers can make outbound HTTPS requests with the standard Fetch API, while Workers AI additionally exposes a native binding. This establishes a plausible runtime path, not proof that the selected package graph bundles under Xpensego's exact Wrangler configuration; the post-approval implementation ticket must keep the deployed Workerd spike as a gate. [Cloudflare Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/), [Workers AI overview](https://developers.cloudflare.com/workers-ai/)

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

Each enabled operation permits one potentially billable attempt. It may make at most two HTTP dispatches only when the first receives an explicit, known-rejected 429 and the single delayed retry remains within the same operation reservation; every ambiguous response ends the operation without another dispatch.

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

The post-approval implementation ticket must reject and remove the SDK before merge, then implement the same OpenAI call with the existing Effect HTTP client, if the deployed bundle proof shows unsupported Node behavior, meaningful cold-start/size regression, unavoidable gateway initialization, Zod-based contract pressure, or a dependency-audit failure. That is a pre-release adapter choice, not a second installed fallback.

## Reliability, idempotency and `outcome_unknown`

The provider call has no domain side effect, but it can create an unrecoverable billed result. Duplicate calls therefore violate both cost and consistency requirements.

### Durable operation state

Before dispatch, atomically insert or claim a record keyed by the server-issued source/request `operation_id` plus `operation_version`, scoped to the authenticated actor, and reserve its maximum cost. Persist the canonical input digest as an integrity value. Reusing an operation identifier with a different digest is an idempotency conflict; identical content under distinct source/request identifiers remains two legitimate operations. Replays return the persisted success or current terminal/unknown state; they do not call the provider again.

Recommended states:

- `prepared`: idempotency record and worst-case budget reservation committed;
- `dispatched`: the HTTP call may have left the Worker;
- `succeeded`: structured result, usage and provider request identifier persisted;
- `explicitly_rejected`: non-retryable provider response, refusal, or invalid request;
- `rate_limited`: explicit rejection eligible for one delayed retry while the lease is valid;
- `invalid_output`: provider returned a result, but Effect validation or finish-reason policy rejected it;
- `outcome_unknown`: dispatch may have been processed, but no trustworthy result/usage was obtained.

### Classification policy

- Validation/configuration/authentication failures before dispatch are terminal and spend no reserved budget.
- An explicit HTTP 429 is known rejected and may be retried once after the provider delay, within the same operation budget.
- HTTP 400/401/403/404, refusal, content filtering, schema rejection, and output truncation are typed terminal outcomes. Truncation does not automatically buy a larger result; adjust the operation version after evaluation.
- Timeout, abort after dispatch, connection loss, malformed/missing response, Worker termination, and HTTP 5xx are `outcome_unknown`. Do not automatically retry them.
- A user/operator may explicitly start one new priced attempt from `outcome_unknown`; it receives a new attempt identifier while preserving the original record and cost reservation. No ledger mutation is created from the unknown attempt.

Set `X-Client-Request-Id` to the opaque attempt identifier and persist OpenAI's returned `x-request-id` when present. OpenAI documents request identifiers for troubleshooting, not as a result-retrieval or idempotency contract, so they do not make unknown attempts safe to retry. [OpenAI error and request diagnostics](https://developers.openai.com/api/docs/guides/error-codes)

AI SDK exposes status, headers, response body and an `isRetryable` hint through `APICallError`; map these immediately to application-owned tagged errors and discard/redact bodies before logging. The SDK's hint does not override the stricter Xpensego ambiguity policy. [AI SDK `APICallError`](https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-api-call-error)

## Cost controls for development and the small alpha

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
- Each fixture specifies the exact decoded output, model/prompt/schema labels, artificial usage/cost, latency clock advance, and one of `Success`, `ExplicitlyRejected`, `RateLimited`, `InvalidOutput`, or `OutcomeUnknown`.
- Unregistered input fails closed with a typed `FixtureMissing`; it never calls a real provider.
- Scripted sequences prove lease recovery and the single safe 429 retry. Duplicate/concurrent calls prove one fixture consumption and one persisted result.
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
- Queue replay, concurrent claims and Worker retry purchase one provider call per operation; unknown outcomes purchase no automatic retry;
- the nano route's provider-call p95 is at most 2.5 seconds in deployed staging so the five-second Telegram experience budget retains room for queue/database/delivery work;
- measured worst-case reservations and actual usage stay within the rate-card calculations; and
- a secret/log/analytics review finds no financial contents or credentials outside approved persistence.

Evaluate mini against the exact failing complex-import slice. Enable it only if it reduces critical errors by at least 30% relative to nano, introduces zero silent critical-field inventions, stays within $0.02 per bounded chunk and passes the same privacy/latency gates. Otherwise keep it disabled.

## Proposed post-approval implementation gates

Issue #13 approves or rejects the provider/model/routing recommendation only; it does not install packages or claim runtime evidence. An approval must synchronize the ADR, Specification, and Checklist, then authorize a separate disposable vertical-spike ticket before the full parser:

1. Pin only `ai@7.0.48` and `@ai-sdk/openai@4.0.27` as direct dependencies; capture the lockfile's transitive gateway and Zod peer impact in dependency review.
2. Bundle and run one Effect-owned structured extraction in local Workerd and deployed staging using Xpensego's actual compatibility date/flags. Prove no Vercel service call, global-scope fetch, unsupported Node API or material bundle/cold-start regression.
3. Prove an Effect Schema can generate the provider JSON Schema and revalidate output without a Zod application schema. Snapshot the generated schema and fail CI on unreviewed drift.
4. Prove `maxRetries: 0`, total timeout, token ceiling, `store: false`, explicit snapshot id, opaque client request id, typed finish/error mapping and content-redacted telemetry from the built Worker.
5. Use provider response headers/usage to persist one successful result and settle its atomic cost reservation; prove Queue duplicate/concurrent execution does not repurchase it.
6. Inject deterministic timeout, network loss, 429, 5xx, refusal, truncation and invalid-output cases. Prove only the explicit 429 receives one automatic retry and every ambiguous case remains `outcome_unknown` without a ledger mutation.
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
```

Additional checks performed after writing this note:

- `npm exec prettier -- --check docs/research/model-gateway-provider-routing.md`
- a native Node `fetch` check followed redirects for every unique public source URL in this note;
- `gh issue view` verified the private-repository issue links; and
- `git status --short` verified that this task added only this research asset and did not touch the existing `.gitignore`, `.agents/`, or `.playwright-mcp/` changes.
