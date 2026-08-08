# Xpensego — Post-Hackathon Delivery Checklist

**Authorities:** [Product Document](./xpensego-product-doc.md) · [PRD](./PRD.md) · [Technical Specification](./SPEC.md) · [Domain Context](./CONTEXT.md)

**Status:** The minimal platform tracer and Telegram adapter have provider-backed staging evidence. Identity and personal-ledger prerequisites are verified locally; recovery email, transaction behavior, deployed identity acceptance, and external-user readiness remain open.

**Execution rule:** Complete phases in order except where a track is explicitly marked parallel. A phase closes only when its exit evidence is linked.

This document owns implementation order, dependencies, work items, and phase evidence. It does not redefine product scope, behavioral requirements, or technical invariants from its authorities.

## Working rules

- Build production-shaped vertical slices through the OpenNext web application, Effect API Worker, Neon Postgres, and the Cloudflare primitive the slice actually needs.
- Treat the [Technical Specification](./SPEC.md) and accepted ADRs as authoritative for runtime, data, reliability, provider, and security constraints; checklist wording cannot weaken them.
- Treat deterministic tests, provider-backed acceptance, staging proof, and production verification as distinct evidence.
- Maintain PRD requirement coverage beside implementation: each **[CORE]** requirement has an owning phase, automated evidence, and an end-to-end or release-gate result.
- Do not extend the hackathon runtimes, mix WhatsApp rules into Telegram code, or build **[POST-SIGNAL]** and **[HOLD]** behavior before its gate.

## Phase 0 — Baseline and ownership

**Goal:** enter implementation with one coherent product and technical direction.

- [x] Product scope, behavior, domain language, architecture, provider policy, and delivery order have distinct canonical documents and accepted ADRs.
- [x] Give every open product or technical decision an owner, decision deadline, and the phase it blocks.
- [x] Record owners and evidence locations for extraction quality, controlled-cohort load, security risk acceptance, recovery objectives, and WhatsApp availability thresholds.

Decision ownership is role-based until named operators are added to the project:

| Decision or evidence gate                                                                 | Accountable owner                            | Decision deadline                                           | Blocks                                  | Evidence location                                      |
| ----------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------ |
| Model provider, model, and routing policy                                                 | Technical lead                               | 2026-08-14                                                  | Phase 2 provider-backed parsing         | Phase 2 evidence links                                 |
| Upload scanning and Queue-versus-Workflow boundaries for large imports and exports        | Technical lead                               | 2026-08-21                                                  | Tracks 3A and Phase 4                   | Track 3A and Phase 4 evidence links                    |
| Event analytics destination and content-minimized event contract                          | Product owner with technical lead            | 2026-08-14                                                  | Phase 2 analytics and Phase 5 readiness | Phase 2 and Phase 5 evidence links                     |
| Retention durations and operator-tooling requirement                                      | Product owner with security owner            | 2026-08-28                                                  | Phases 4 and 5                          | Phase 4 and Phase 5 evidence links                     |
| Extraction and categorization quality thresholds                                          | Product owner with evaluation owner          | 2026-08-21                                                  | Track 3A exit and Phase 5               | Versioned evaluation report linked from Track 3A       |
| Controlled-cohort load profile and latency percentiles                                    | Technical lead                               | 2026-09-04                                                  | Phase 5                                 | Deployed-staging load report linked from Phase 5       |
| Threat-model findings and security risk acceptance                                        | Security owner, accountable to product owner | 2026-09-04                                                  | External-user invitations               | Threat model and acceptance record linked from Phase 5 |
| Recovery objectives, Neon region/tier, backup retention, key ownership, and restore proof | Technical lead with security owner           | 2026-09-04                                                  | External-user invitations               | Restore report linked from Phase 5                     |
| Cloudflare plan and measured capacity headroom                                            | Technical lead                               | 2026-09-04                                                  | External-user invitations               | Capacity report linked from Phase 5                    |
| WhatsApp availability thresholds and Meta onboarding go/no-go                             | Product owner                                | Before Phase 8 starts, after the controlled-cohort decision | Phase 8                                 | Written cohort decision and Phase 8 evidence links     |

**Exit gate:** the Product Document, PRD, Specification, Checklist, README, domain context, and accepted ADRs contain no hackathon-scope or target-platform contradiction; every unresolved decision has a dated owner.

## Phase 1 — Minimal platform tracer

**Goal:** prove the replacement stack with the smallest reproducible path before product feature work.

**Blocked by:** Phase 0.

**PRD coverage:** technical foundation for all **[CORE]** requirements.

- [x] Create the TypeScript workspace with `apps/web`, `apps/api`, and shared `domain`, `adapters`, `contracts`, `config`, and `testing` packages.
- [x] Pin the runtime, package manager, Next.js, OpenNext, Effect, Wrangler, database, migration, test, and build-tool versions.
- [x] Enable strict TypeScript, formatting, linting, unit tests, production builds, secret scanning, dependency auditing, and the same checks in CI.
- [x] Define the Effect boundary: versioned schemas, typed errors, services and Layers, redacted configuration, bounded retries and timeouts, telemetry, deterministic test Layers, and one execution boundary per Worker entrypoint.
- [x] Configure local, development, and staging environments with typed Cloudflare bindings, an explicit compatibility date, validated defaults, and secret bindings.
- [x] Deploy a minimal OpenNext application and prove Server Components plus an explicitly dynamic authenticated route in a local production-runtime preview and deployed staging.
- [x] Select the Workers-compatible PostgreSQL query and migration stack: Effect SQL, `@effect/sql-pg`, its `pg` backend, and Effect's forward-only migrator ([ADR 0003](./docs/adr/0003-effect-sql-postgres-migrations.md)).
- [x] Select self-hosted Better Auth with application-owned identity and Resend-backed recovery email for development and the small alpha ([ADR 0004](./docs/adr/0004-better-auth-effect-http-api.md)).
- [x] Provide reproducible local PostgreSQL with separate migration and runtime roles; prove the runtime role has DML authority without schema or migration authority.
- [x] Provision separate Neon development and staging projects, direct non-pooler Hyperdrive endpoints, and distinct least-privilege runtime and migration roles.
- [x] Write and apply the minimal ownership, idempotency, inbound-event, and outbox schema; prove a forward migration from a clean local PostgreSQL database.
- [x] Prove the same forward migration from an empty PostgreSQL database in CI.
- [x] Disable query caching on every initial Hyperdrive binding and test that one user's data cannot be returned in another authorization context.
- [x] Deploy a minimal API Worker whose `fetch` and `queue` entrypoints run Effect programs through the controlled boundary.
- [x] From staging, prove a real PostgreSQL transaction, uniqueness constraint, concurrent idempotency case, scale-to-zero wake-up, and bounded reconnect behavior through Hyperdrive.
- [x] Prove one transaction → outbox → Queue → duplicate-safe consumer path, including failed publication recovery through an idempotent dispatcher and a retry or dead-letter recovery path.
- [x] Establish baseline application-emitted structured logs, correlation and job IDs, safe error reporting, request/job metrics, and Cloudflare usage visibility without financial contents.

**Phase 1 evidence (2026-08-01):**

- The [Phase 1 staging report](./docs/evidence/phase1-staging.md) is the detailed evidence authority and records the exact revision, hosted runs, measurements, telemetry audit, and proof boundaries.
- `npm run check` passes formatting, type-aware lint, strict type-checking, 36 behavioral tests, 16 policy tests, package builds, an API Worker dry-run, a Next.js production build, and an OpenNext Cloudflare bundle. `npm run test:integration` passes 16 PostgreSQL/Workerd tests.
- [CI run 30704849320](https://github.com/Vaibtan/XpensGo/actions/runs/30704849320) repeats the locked install, quality/build gates, empty-PostgreSQL migration/integration suite, complete-history secret scan, and reviewed dependency policy on Linux.
- The local OpenNext production-runtime preview served the Server Component and proved anonymous redirect plus private authenticated rendering through the locally registered API Worker; the evidence report records the observed statuses, cache policy, and fixture cleanup.
- [Managed staging run 30704943776](https://github.com/Vaibtan/XpensGo/actions/runs/30704943776) proves revision-bound OpenNext SSR, authenticated isolation, uncached Hyperdrive/Neon access, concurrent idempotency, Cron/Queue recovery, duplicate-safe consumption, and scale-to-zero wake-up.
- The dependency gate accepts exactly six reviewed package findings covered by four current upstream advisories. Its fail-closed allowlist expires on 2026-08-15; forced downgrades and unverified transitive overrides remain prohibited.
- This evidence does not claim recovery-email delivery, Telegram behavior, a real provider DLQ transition, backup/restore, production capacity, or external-user readiness.

**Exit gate:** a clean clone installs, migrates, type-checks, tests, and builds without production credentials; staging proves OpenNext SSR, the Effect `fetch`/`queue` boundary, uncached Neon access through Hyperdrive, concurrent idempotency, and one recoverable outbox/Queue path.

## Phase 2 — Complete identity and Telegram-to-ledger slice

**Goal:** an authenticated user can create transactions through web and Telegram, then correct, remove, and restore them on the web without duplicate or cross-user effects.

**Blocked by:** Phase 1.

**PRD coverage:** FR-1, FR-3, FR-7, FR-9, FR-10, and the first complete slice of FR-17, FR-18, and FR-20.

### Identity and ledger prerequisites

- [ ] Implement the approved signup, sign-in, sign-out, session validation, and account-recovery policy.
- [x] Create one personal ledger with a non-null `owner_user_id` per user and enforce that ownership relationship with a unique constraint.
- [x] Seed stable initial category identifiers before the first transaction is written.
- [x] Capture a user timezone during onboarding, apply a documented default, and let the user change it.
- [x] Implement expiring one-use verification for Telegram linking and unlinking plus visible link state and safe relinking.
- [x] Test channel-identity uniqueness, challenge replay, unlinking, relinking, session expiry, and two-user isolation.

**Identity prerequisite evidence (local):** [Identity and personal Ledger foundation](./docs/evidence/identity-foundation.md). This is implementation evidence, not Telegram-provider or deployed-staging acceptance.

### Telegram ingress and durable replies

- [x] Verify the configured webhook secret before reading the body or opening a database connection.
- [x] Register the staging webhook and capture provider-backed secret-verification evidence.
- [x] Decode supported private text updates at the boundary; reject oversized, malformed, unsupported, and unsafe group-chat operations without exposing personal data.
- [x] Persist and deduplicate `update_id`, then write the inbound event and dispatch outbox record in one PostgreSQL transaction before acknowledgement.
- [x] Queue and normalize the event through the shared channel contract, resolve identity server-side, and enforce per-identity and system-wide abuse limits.
- [x] Persist each reply intent and delivery outbox record before sending; record attempt, platform acceptance, transient failure, terminal failure, and outcome-unknown separately.
- [x] Suppress blind duplicate sends after an ambiguous Telegram provider outcome or an expired provider-attempt lease.
- [x] Capture real provider acceptance/rejection evidence and add an explicit operator recovery policy for terminal delivery records.

**Telegram adapter evidence:** [local webhook, processing, and reply adapter](./docs/evidence/telegram-adapter-local.md) · [staging webhook, duplicate, acceptance, rejection, and recovery evidence](./docs/evidence/telegram-staging.md).

### Manual capture and ledger control

- [x] Select the OpenAI-only initial model provider, pinned nano routing, Effect Schema boundary, operation-specific retry policy, and budget/kill-switch controls; preserve the deterministic Model Gateway adapter for tests and normal local development.
- [ ] Complete the [model-gateway Workerd, durable-attempt, failure, cost, and synthetic-corpus proof](https://github.com/Vaibtan/XpensGo/issues/19) before provider-backed parsing; remove AI SDK if its conditional adapter gate fails and never retain a fallback implementation.
  - Local gates pass for the Effect-owned adapter, strict root-object schema, durable attempts/restart/budgets, failure injection, Queue replay, Workerd, and the versioned synthetic spike corpus. The API Worker delta from `dceef03` is +1,402.31 KiB raw / +220.32 KiB gzip (4,904.26 / 859.88 KiB total), with no dependency-audit findings.
  - Remaining evidence is forward migration `0011`, same-revision staging deployment with `OPENAI_API_KEY`, deployed startup impact, and the provider-backed corpus proof. This spike corpus does not complete the broader release corpus in Track 3A.
- [ ] Implement debit and credit creation from both a web form and ordinary-language Telegram messages.
- [ ] Support one or multiple transactions, one focused missing-amount clarification, English and Hinglish fixtures, and relative dates resolved in the user's timezone.
- [ ] Store each monetary value as a positive integer minor-unit `BIGINT` with an ISO 4217 currency and explicit `debit | credit` direction; prohibit floating-point and signed-amount representations.
- [ ] Enforce valid category identifiers, immutable source records, initiating identity, and audit events.
- [ ] Echo amount, direction, category, and resolved date in confirmations.
- [ ] Implement authenticated ledger list, search, date/category/direction/source/counterparty filters, detail, correction, revision history, soft delete, and undo on web.
- [ ] Use stable cursor pagination for mutable ledger lists and exclude soft-deleted transactions from normal reads.
- [ ] Record activation, request outcome, model usage, and cost without copying financial contents into analytics.
- [ ] Test malformed input, webhook and Queue duplicates, outbox recovery, concurrent creation, ambiguous send outcomes, corrections, deletion/undo, stable pagination, and cross-user access.

**Model Gateway decision:** [ADR 0005](./docs/adr/0005-effect-openai-model-gateway.md) · [product-owner approvals](https://github.com/Vaibtan/XpensGo/issues/13) · [research rationale and dated evidence](./docs/research/model-gateway-provider-routing.md).

**Exit gate:** web signup → Telegram link → ordinary-language transaction → durable Telegram reply → web ledger passes in staging; web manual creation, correction, soft delete, and undo also pass, including duplicate delivery and two-user isolation tests.

## Track 3A — Imports, categorization, and review

**Goal:** pasted messages and CSV files become traceable, correctable ledger data without silent loss.

**Blocked by:** Phase 2. May run in parallel with Tracks 3B and 3C.

**PRD coverage:** FR-4 through FR-9 and the import/review portions of FR-17, FR-18, and FR-20.

### Controlled upload and durable import

- [ ] Approve file-size, row-count, content-type, scanning, quarantine, retention, and rejection policies before accepting files.
- [ ] Provision staging R2 and prove upload, checksum, ownership metadata, quarantine, retrieval, expiry, and deletion.
- [ ] Implement one controlled intake capability used by web uploads and authenticated Telegram document retrieval; acknowledge Telegram before asynchronous media retrieval, then determine type from content and scan before parsing.
- [ ] Persist imports, immutable source records, review items, object lifecycle, idempotency, progress, and terminal status in PostgreSQL.
- [ ] Accept pasted transaction messages from web and Telegram through the same idempotent import service; allow simple Telegram review decisions and deep-link complex or bulk review to web.
- [ ] Process imports through a bounded, duplicate-safe Queue pipeline with typed retry, dead-letter, cancellation, and operator recovery.
- [ ] Show progress, inserted/review/duplicate/failed counts, and terminal CSV status on web and Telegram.

### Extraction, categorization, and review

- [ ] Move the reviewed bank/UPI corpus into the versioned testing package and add adversarial amount, direction, date, duplicate, encoding, locale, quoting, formula-injection, and mixed-validity fixtures.
- [ ] Implement deterministic extraction where reliable and model-assisted extraction behind the Model Gateway where needed.
- [ ] Apply user rule → deterministic mapping → model suggestion precedence and record parser, prompt, schema, rule, and model versions.
- [ ] Record provider request identifiers, cost, and outcome-unknown model attempts; reconcile usage where supported without duplicating accepted domain mutations.
- [ ] Preview ambiguous CSV column mappings before commit and preserve each exact source row; keep valid rows while routing unsupported, low-confidence, malformed, and likely duplicate records to visible review.
- [ ] Neutralize spreadsheet formulas in previews and generated exports.
- [ ] Implement accept, edit, merge, skip, retry, bulk acceptance, bulk category correction, and create/inspect/edit/disable/delete for user categorization rules.
- [ ] Explain the preserved source, applied rule or model version, and confidence where available.
- [ ] Preserve reversible correction history, stable pagination for mutable review lists, and strict per-user rule isolation.
- [ ] Publish field-level extraction and categorization results by source format, counterparty, and model/rule version; expose “Other” share and meet the approved numeric thresholds and zero-silent-invention rules.

**Exit gate:** web and Telegram CSV/paste → controlled intake → import → review → correction rule → repeat import passes in staging, with no silent record loss and approved field-level quality evidence.

## Track 3B — Structured questions and web insights

**Goal:** Telegram and web return deterministic, correctly scoped answers from the same ledger.

**Blocked by:** Phase 2. May run in parallel with Tracks 3A and 3C; only the budget-status adapter waits for Track 3C.

**PRD coverage:** FR-13 and the query portions of FR-17, FR-18, and FR-20.

- [ ] Implement versioned structured query requests for totals, comparisons, maxima, listings, averages, credits, counterparties, categories, and budget status.
- [ ] Interpret ordinary-language Telegram and web questions into supported query slots through the bounded Conversation and Model Gateway seams.
- [ ] Inject user and ledger scope from authenticated context; prohibit executable model-written database queries.
- [ ] Return calculation dates, direction, filters, and ledger context with deterministic results; disclose partial-ledger limits without financial-advice framing.
- [ ] Render concise number-first Telegram answers and web insight views through the same Query interface.
- [ ] Return bounded unsupported and ambiguous responses rather than fabricated answers.
- [ ] Add English, Hinglish, follow-up, adversarial, credit, date-boundary, soft-delete, stable-pagination, and two-user fixtures.
- [ ] Record query class, outcome, latency, model usage, and cost without question contents in product analytics.

**Exit gate:** every supported query class, including budget status after Track 3C, passes deterministic module tests and Telegram/web staging tests against the same seeded ledger.

## Track 3C — Budgets, consent, alerts, and delivery

**Goal:** proactive value is consented, private, idempotent, and recoverable.

**Blocked by:** Phase 2. May run in parallel with Tracks 3A and 3B.

**PRD coverage:** FR-2, FR-15, FR-16, and the budget/notification portions of FR-17, FR-18, FR-20, and FR-21.

- [ ] Implement create, change, list, and remove for monthly category budgets using live debits and the user's timezone; show spent, remaining, percentage used, and days remaining on web and messaging.
- [ ] Record consent purpose, source, and time; keep budget alerts, summaries, product announcements, and future recurring alerts independently controllable from transactional use.
- [ ] Implement per-channel preference, immediate opt-out, and detailed versus privacy-preserving previews.
- [ ] Provision a staging Cron Trigger that only enqueues idempotent budget-evaluation work.
- [ ] Create at most one durable outbound intent for each 80% and 100% threshold crossing per budget and month, then dispatch it through the shared outbox/Queue path.
- [ ] Keep selection, attempt, platform acceptance, delivery, failure, suppression, and outcome-unknown states distinct.
- [ ] Reconcile ambiguous provider outcomes where supported and prevent blind duplicate successful sends.
- [ ] Provide budget and delivery history on web and independent kill switches for model work and proactive notifications.
- [ ] Test month rollover, timezone boundaries, soft deletion, credits, concurrent schedulers, Queue retry, opt-out, privacy mode, ambiguous provider outcomes, and duplicate suppression.

**Exit gate:** a staged budget crosses both thresholds, delivers each at most once, survives a forced Queue/provider failure, handles an ambiguous outcome safely, and stops selection immediately after opt-out.

## Phase 4 — Export, permanent deletion, and trust completion

**Goal:** users can retrieve and permanently remove their data without operator intervention.

**Blocked by:** Track 3A. Implementation may proceed while Tracks 3B and 3C finish; closure waits for their complete live-data inventory.

**PRD coverage:** FR-11, FR-12, and the data-rights/operator portions of FR-17, FR-20, and FR-21.

- [ ] Approve retention and deletion rules for sources, conversations, imports, exports, jobs, audit events, provider data, and backups.
- [ ] Implement authenticated asynchronous export through Queue workers with transactions, source type, categories, corrections, and timestamps; store generated objects in R2, publish the machine-readable format, and use expiring authorized downloads.
- [ ] Require recent authentication and short-lived server-side confirmation for permanent deletion.
- [ ] Provision a staging Cloudflare Workflow for ordered, checkpointed, idempotent deletion and prove resume after a failed step without duplicate mutation.
- [ ] Delete or irreversibly anonymize owned database records, R2 objects, job payloads, conversations, exports, and provider-held data as documented.
- [ ] Retain only content-minimized deletion evidence and report completion or actionable failure to the user.
- [ ] Publish a privacy notice matching actual providers and behavior.
- [ ] Test interrupted export/deletion, retry, expiry, provider-cleanup ambiguity, object cleanup, and completion reporting.

**Exit gate:** export and permanent deletion pass end to end in staging; a failed Workflow resumes safely and the completed Tracks 3A–3C data inventory proves that every owned live-data location follows the documented lifecycle.

## Phase 5 — External-user invite readiness

**Goal:** prove that the complete core product can safely accept real financial data from external users.

**Blocked by:** Tracks 3A–3C and Phase 4.

**PRD coverage:** completion evidence for FR-1 through FR-13, FR-15 through FR-18, FR-20, FR-21, all non-functional requirements, and the core release gate.

### Production, recovery, and operations

- [ ] Recheck current Cloudflare, Neon, OpenNext, Effect, Telegram, model, and authentication documentation, limits, pricing, and runtime compatibility.
- [ ] Provision isolated production Workers, Hyperdrive, Queues, Workflow, Cron, R2, secrets, and configuration with least-privilege bindings.
- [ ] Select the measured production region and a paid Neon plan whose restore window and support satisfy approved recovery-point and recovery-time objectives.
- [ ] Keep production runtime and migration roles distinct, migration credentials outside Workers, and query caching disabled on every production Hyperdrive binding.
- [ ] Prove encrypted backup creation, key ownership, access control, retention, restoration, and deletion; verify that restored data still follows the documented account-deletion lifecycle.
- [ ] Review migrations with a deployment and forward-recovery procedure and complete a production-shaped migration rehearsal.
- [ ] Measure Worker CPU and subrequests, Queue throughput and age, Workflow and R2 use, database wake/query behavior, and expected bursts; choose or upgrade the Cloudflare plan with documented headroom and alerts.
- [ ] Complete dashboards, alerts, and runbooks for requests, jobs, unknown provider outcomes, imports, delivery, model cost, platform capacity, backup/restore, incidents, and both kill switches.
- [ ] Enforce and verify access, retention, and export controls for provider-managed invocation diagnostics that may receive authorization or cookie metadata.
- [ ] Keep sensitive support access disabled by default; if enabled, require approved purpose, least privilege, automatic expiry, and a content-minimized audit trail, then test grant, expiry, and revocation.

### Measurable release evidence

- [ ] Approve the controlled-cohort load profile and percentiles, then demonstrate every [PRD UX latency budget](./PRD.md#ux-latency-budgets), measuring webhook transport acknowledgement separately.
- [ ] Pass automated accessibility checks with no serious or critical violations and manual keyboard, focus, label, contrast, and error-announcement checks on core flows against WCAG 2.2 AA.
- [ ] Verify onboarding, ledger review, imports, correction, budgets, export, and deletion on supported mobile-width browsers.
- [ ] Complete a threat model, authorization matrix, webhook/upload/CSRF review, dependency and secret scans, and cross-user destructive-flow tests with no unaccepted critical or high finding.
- [ ] Meet the approved extraction/categorization thresholds and zero-silent-invention rules on the versioned release corpus.
- [ ] Pass the complete web/Telegram regression suite, local production-runtime previews, provider-backed acceptance, staging end-to-end suite, and synthetic production smoke tests.
- [ ] Link every **[CORE]** PRD requirement to its implementation, automated tests, operational signal, and release evidence; unproven coverage blocks invitations.
- [ ] Verify analytics for activation, time-to-value, imports, review, corrections, rules, queries, budgets, alerts, retention, provider outcomes, and cost without financial contents.
- [ ] Before invitations, lock the controlled-cohort observation window, minimum interview count, product-quality thresholds, safety stop conditions, and written continue/narrow/pivot/stop criteria.

**Exit gate:** the [Product Document's invite-readiness gate](./xpensego-product-doc.md#invite-readiness-gate) passes with linked evidence for every Phase 5 task. No external user's real financial data is accepted before this gate.

## Phase 6 — Controlled cohort validation

**Goal:** learn from the initial controlled cohort without expanding product scope.

**Blocked by:** Phase 5.

- [ ] Run the [initial controlled cohort defined by the Product Document](./xpensego-product-doc.md#initial-controlled-cohort-outcome), including its approved size and onboarding-completion threshold.
- [ ] Review support feedback, security/privacy incidents, import quality, unknown provider outcomes, and operational health at least weekly.
- [ ] Collect and evidence every activation, quality, usage, retention, and cost signal owned by the controlled-cohort gate.
- [ ] Conduct structured interviews about ledger trust, categorization quality, retention behavior, and willingness to pay.
- [ ] Write a continue, narrow, pivot toward small business, or stop decision before WhatsApp or post-signal implementation starts.

**Exit gate:** the [Product Document's controlled-cohort outcome](./xpensego-product-doc.md#initial-controlled-cohort-outcome) is recorded. Only its explicit **continue** decision may start WhatsApp.

## Phase 7 — Broader business-signal gate

**Goal:** determine whether the consumer thesis earns broader investment.

**Blocked by:** Phase 6 decision to continue. May run in parallel with WhatsApp implementation.

- [ ] Before expanding measurement, lock the terms required by the [Product Document's business-signal gate](./xpensego-product-doc.md#business-signal-gate).
- [ ] Collect and evidence every adoption, retention, interview, and cost signal defined by that gate.
- [ ] Apply the Product Document's stop condition without relabelling a missed threshold as success.
- [ ] Reconfirm support burden, channel economics, and a testable pricing/entitlement hypothesis.
- [ ] Record a written go/no-go decision for monetization experiments and each post-signal product brief.

**Exit gate:** the [Product Document's business-signal gate](./xpensego-product-doc.md#business-signal-gate) has a recorded decision, with every missed threshold left visible in the evidence.

## Phase 8 — WhatsApp channel

**Goal:** add WhatsApp through the existing product seams without duplicating ledger, import, query, or notification behavior.

**Blocked by:** the written Phase 6 **continue** decision. May run in parallel with Phase 7; public availability remains independently gated.

**PRD coverage:** FR-19.

- [ ] Before implementation, approve measurable WhatsApp availability thresholds for onboarding completion, delivery reliability, opt-out, template quality, support load, and cost.
- [ ] Complete Meta Business Platform production onboarding and secure the business phone number and credentials.
- [ ] Implement webhook verification/signature validation and normalize inbound messages plus status events through the channel seam.
- [ ] Persist and deduplicate event/message identifiers and reuse the existing link, unlink, and relink flows.
- [ ] Retrieve media with authentication and pass it through the common controlled-upload and storage capability.
- [ ] Track customer-service windows and enforce approved template, consent, category, and eligibility rules for proactive messages.
- [ ] Record template category, attempt, platform acceptance, delivery/read state, quality signals, cost, and outcome-unknown.
- [ ] Reconcile ambiguous provider outcomes using Meta identifiers/status when available and prevent unsafe duplicate sends.
- [ ] Support detailed and privacy-preserving templates using shared notification preferences.
- [ ] Add fixtures, contract tests, provider-backed acceptance, staging end-to-end tests, and a limited WhatsApp cohort.

**Exit gate:** WhatsApp users access the same authorized ledger and applicable core workflows as web and Telegram, and the approved window, template, consent, delivery, privacy, quality, support, and cost thresholds pass before public availability.

## Roadmap guardrail

The [Product Document's deferred scope](./xpensego-product-doc.md#8-explicitly-deferred), PRD **[POST-SIGNAL]**/**[HOLD]** registry, and [Feature Opportunity Map](./FEATURE-RESEARCH.md) govern all work beyond Phase 8. Any promoted capability requires its own approved brief, success metric, dependency review, and stop condition.
