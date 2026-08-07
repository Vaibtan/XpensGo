---
status: accepted
date: 2026-08-07
---

# Use an Effect-owned OpenAI model gateway with durable attempt control

Xpensego will use an application-owned Effect Model Gateway with OpenAI as the sole initial provider and the pinned GPT-5.4 nano snapshot as the only enabled model. The Vercel AI SDK core and OpenAI adapter may be used only if the Workerd and dependency proof in [issue #19](https://github.com/Vaibtan/XpensGo/issues/19) passes; otherwise they are removed before merge and the adapter uses the existing Effect HTTP client. Effect Schema remains the only application contract authority, and no Vercel AI Gateway, agent framework, parallel Zod contract, provider fallback, or automatic model fallback is installed.

## Considered options

- Maintain several providers or model tiers as runtime fallbacks.
- Call OpenAI directly through the Effect HTTP client from the start.
- Use the AI SDK only inside the provider adapter, subject to an explicit Workerd, bundle, dependency, and schema-boundary proof.

The selected approach buys one narrow structured-output adapter experiment without surrendering routing, contracts, retries, cost authority, persistence, or telemetry to that SDK. It also preserves a tested removal path rather than carrying dormant fallback implementations.

## Consequences

- The initially enabled operations are single-transaction extraction, extraction of at most five pasted transactions, and query-slot filling. Mini-backed imports and free-form answer generation remain disabled behind separate evaluation and approval gates.
- Each operation derives provider JSON Schema from its Effect Schema and decodes the result again through that Effect Schema before application/domain validation or persistence.
- The durable Model Operation service and PostgreSQL store are the sole retry and cost authorities. AI SDK retries are disabled, provider dispatch is not wrapped in `Effect.retry`, and Queue redelivery cannot authorize another call.
- Only an explicit classified transient 429 may receive the operation-bounded automatic redispatch. Timeout, connection loss, missing or malformed response, post-dispatch 5xx, and completion missing after attempt-lease expiry retain distinct typed identities and end as `outcome_unknown` without automatic redispatch.
- An explicit restart from `outcome_unknown` creates one new linked priced operation, reservation, and attempt lineage; it cannot rewrite or resolve the original unknown attempt.
- Development and staging share a $1 monthly provider ceiling. The controlled alpha has a $5 monthly ceiling, an initial $0.25 per-user monthly allowance, and a 20-provider-dispatch daily abuse ceiling. PostgreSQL reservations and the application kill switch are synchronous; provider-side budget alerts are defense in depth.
- Real financial contents remain prohibited until the separate invite-readiness privacy and retention gate passes. Prices and provider claims remain point-in-time evidence in the [research note](../research/model-gateway-provider-routing.md), not technical-specification facts.
