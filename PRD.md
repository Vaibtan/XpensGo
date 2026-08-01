# Xpensego — Product Requirements Document v2.2

**Status:** Canonical post-hackathon requirements
**Updated:** 31 July 2026
**Product authority:** [Product Document](./xpensego-product-doc.md)
**Technical implementation:** [Technical Specification](./SPEC.md)
**Delivery order:** [Delivery Checklist](./CHECKLIST.md)

This document owns testable user, operator, and quality requirements. It does not redefine product rationale and validation signals from the Product Document, technical design from the Specification, or implementation sequencing from the Checklist.

## 1. Purpose

This document converts the Product Document's scope into stable requirement identifiers and acceptance conditions, separating invite-ready behavior from later channel and research work.

Requirement tags:

- **[CORE]** — required before inviting the initial measured cohort.
- **[WHATSAPP]** — required for the second messaging channel after the controlled-cohort continue decision.
- **[POST-SIGNAL]** — considered only after the associated validation gate.
- **[HOLD]** — explicitly not planned.

`FEATURE-RESEARCH.md` informs prioritization but does not override these tags.

## 2. Scope mapping

The [Product Document](./xpensego-product-doc.md#7-initial-product-scope) owns the scope boundary. The requirements below translate that boundary into testable behavior: **[CORE]** covers the invite-ready web and Telegram product, while **[WHATSAPP]**, **[POST-SIGNAL]**, and **[HOLD]** remain governed by their product gates.

## 3. Users, ledgers, and identities

### FR-1 User account and personal ledger **[CORE]**

- FR-1.1 A user can create and authenticate a web account.
- FR-1.2 Every user receives one personal ledger.
- FR-1.3 A ledger is isolated from every unrelated user.
- FR-1.4 Every mutation records the authenticated user, initiating surface, and, where applicable, messaging channel identity.
- FR-1.5 A user can link more than one channel identity to the same account.
- FR-1.6 A channel identity can belong to only one user at a time.
- FR-1.7 Linking and unlinking a channel requires an expiring, one-use verification flow.

**Acceptance:** a transaction created through Telegram is visible to the same linked user on the web; another user cannot read, query, modify, export, or delete it.

### FR-2 Consent and notification preferences **[CORE]**

- FR-2.1 The product records the purpose, source, and time of consent for proactive notifications.
- FR-2.2 Budget alerts, summaries, product announcements, and future recurring alerts have independent preferences.
- FR-2.3 Transactional use does not imply marketing consent.
- FR-2.4 Opt-out takes effect before the next outbound notification is selected.
- FR-2.5 Users can choose detailed or privacy-preserving notification previews.

## 4. Capture and imports

### FR-3 Manual transaction logging **[CORE]**

Users can record debits and credits through Telegram and the web application.

- FR-3.1 Natural text can describe one or multiple transactions.
- FR-3.2 Each transaction records direction, positive amount, currency, category, description, date, and source.
- FR-3.3 Relative dates are resolved in the user's timezone.
- FR-3.4 A missing amount produces one focused clarification rather than a guess.
- FR-3.5 Every confirmation echoes amount, direction, category, and resolved date.
- FR-3.6 Credits never reduce spending totals unless a query explicitly asks for net movement.
- FR-3.7 Money is represented without floating-point rounding errors.

### FR-4 Pasted transaction messages **[CORE]**

Users can paste one or more bank or UPI transaction messages through Telegram or the web application.

- FR-4.1 The import preserves each source record exactly as supplied.
- FR-4.2 Extraction produces amount, direction, date, counterparty, description, currency, and confidence.
- FR-4.3 The parser supports the maintained evaluation corpus of target Indian bank and payment formats.
- FR-4.4 Records that cannot be parsed safely become review items; they are not silently dropped.
- FR-4.5 Likely duplicates become review items; they are not silently inserted or discarded.
- FR-4.6 Reprocessing the same channel event or import cannot create a second import.
- FR-4.7 The user receives an import summary with inserted, review, duplicate, and failed counts.
- FR-4.8 No messaging channel can access the user's device inbox.

### FR-5 CSV statement import **[CORE]**

- FR-5.1 Users can upload a CSV statement through the web application or Telegram.
- FR-5.2 The import detects common date, description, amount, debit, credit, and direction columns.
- FR-5.3 The product previews its interpretation before committing ambiguous formats.
- FR-5.4 Every resulting transaction retains its source row and import identifier.
- FR-5.5 File-size, row-count, type, and processing limits are enforced before expensive work.
- FR-5.6 Invalid rows are reported individually without losing valid rows from the same import.
- FR-5.7 Imports expose durable progress and terminal status.

### FR-6 Import review **[CORE]**

- FR-6.1 The web application lists ambiguous, low-confidence, invalid, and likely duplicate records.
- FR-6.2 A user can accept, edit, merge, skip, or retry a review item where applicable.
- FR-6.3 Bulk acceptance and bulk category correction are available when the decision is unambiguous.
- FR-6.4 Every decision is auditable and reversible until the configured undo period expires.
- FR-6.5 Telegram can resolve a simple review item; complex or bulk review can deep-link to the web application.

## 5. Categorization

### FR-7 Default categories **[CORE]**

- FR-7.1 The beta launches with a stable Indian-oriented default taxonomy.
- FR-7.2 Default category identifiers remain stable even if display labels change.
- FR-7.3 "Other" is a visible quality signal, not a category where failures are hidden.
- FR-7.4 Categorization quality is measured by source format, counterparty, and model or rule version.

### FR-8 Categorization rules **[CORE]**

- FR-8.1 Correcting a recognized counterparty can create or update a user-specific categorization rule.
- FR-8.2 Future matching transactions apply the user's rule before a general model suggestion.
- FR-8.3 The user can inspect, edit, disable, and delete their rules.
- FR-8.4 A rule never affects another user's ledger.
- FR-8.5 Rule application is deterministic and records which rule was used.

### FR-9 Transaction correction **[CORE]**

- FR-9.1 A user can correct amount, direction, date, description, counterparty, and category.
- FR-9.2 A correction preserves the prior value in the audit history.
- FR-9.3 The product distinguishes correcting one transaction from teaching a future categorization rule.
- FR-9.4 Explanations show the source record, applied rule or model version, and confidence where available.
- FR-9.5 Corrections made on web are reflected in subsequent Telegram answers.

## 6. Ledger control and data rights

### FR-10 Ledger review **[CORE]**

- FR-10.1 The web application lists transactions with search, date, category, direction, source, and counterparty filters.
- FR-10.2 Totals and filters exclude soft-deleted transactions by default.
- FR-10.3 Users can inspect the source record and history of a transaction.
- FR-10.4 Pagination does not expose or skip records because another user's data changed.

### FR-11 Deletion and undo **[CORE]**

- FR-11.1 Users can soft-delete one or more transactions.
- FR-11.2 Soft-deleted transactions disappear from queries, budgets, and alerts.
- FR-11.3 Deletion can be undone during the configured undo period.
- FR-11.4 Permanent account deletion requires recent authentication and an explicit server-side confirmation state.
- FR-11.5 Permanent deletion removes or irreversibly anonymizes all user-linked data according to the published data lifecycle.
- FR-11.6 Permanent deletion completion is visible to the user and auditable without retaining the deleted financial contents.

### FR-12 Export **[CORE]**

- FR-12.1 Users can export their ledger in a documented machine-readable format.
- FR-12.2 The export includes transactions, source type, categories, corrections, and timestamps.
- FR-12.3 Export generation is asynchronous when it cannot complete within a normal request.
- FR-12.4 Only the authenticated user can retrieve the finished export, and the download expires.

## 7. Questions and insights

### FR-13 Structured ledger questions **[CORE]**

Users can ask ordinary-language questions through Telegram and the web application.

- FR-13.1 Supported questions include totals, comparisons, largest transactions, listings, averages, credits, counterparties, categories, and budget status.
- FR-13.2 Answers use structured, server-scoped query operations; a model never writes executable database queries.
- FR-13.3 Every query derives its ledger from authenticated context rather than model or client input.
- FR-13.4 Spending defaults to debits.
- FR-13.5 Answers lead with the requested number or result.
- FR-13.6 An unsupported question receives a bounded explanation instead of a fabricated answer.
- FR-13.7 The answer can disclose which dates, ledger, and transaction set were used.
- FR-13.8 Xpensego does not present a partial ledger as financial advice or certainty.

### FR-14 Projections **[POST-SIGNAL]**

- FR-14.1 A projection lists the records and assumptions on which it depends.
- FR-14.2 Missing balances, income, liabilities, or recurring costs reduce confidence and are disclosed.
- FR-14.3 A projection is not labelled as an affordability verdict or financial advice.

## 8. Budgets and notifications

### FR-15 Monthly category budgets **[CORE]**

- FR-15.1 Users can create, change, list, and remove monthly category budgets.
- FR-15.2 Budget usage counts live debit transactions only.
- FR-15.3 Web and messaging surfaces show spent, remaining, percentage used, and days remaining.
- FR-15.4 The configured user timezone determines month boundaries.

### FR-16 Budget alerts **[CORE]**

- FR-16.1 Users can opt into threshold alerts per channel.
- FR-16.2 The initial thresholds are 80% and 100%; each threshold is sent at most once per budget month.
- FR-16.3 Notification selection and delivery are separate states.
- FR-16.4 A classified transient delivery failure is retryable and is not recorded as delivered. Terminal failures and outcome-unknown attempts are not retried blindly.
- FR-16.5 Alert history distinguishes selected, attempted, provider-accepted, delivered or read where the channel reports it, outcome-unknown, failed, and suppressed outcomes.
- FR-16.6 A privacy-preserving template does not expose amount or category in the notification preview.

## 9. Web application

### FR-17 Web control surface **[CORE]**

The web application provides:

- onboarding and Telegram linking;
- ledger and transaction detail;
- import progress and review;
- categories and categorization rules;
- budgets and notification preferences;
- structured conversational insights;
- export and account deletion;
- privacy and consent information.

- FR-17.1 Core workflows are usable on mobile-width screens.
- FR-17.2 Financial totals are not cached across users or beyond their valid authorization context.
- FR-17.3 Accessibility is tested for keyboard operation, labels, focus, contrast, and error announcements.

## 10. Telegram

### FR-18 Telegram channel **[CORE]**

- FR-18.1 Telegram uses webhooks in production.
- FR-18.2 Every update is authenticated as originating from the configured bot integration.
- FR-18.3 The Telegram update identifier provides idempotency.
- FR-18.4 Webhook acknowledgement is independent from downstream model and import processing.
- FR-18.5 Telegram channel identity is linked to a web user through a one-use flow.
- FR-18.6 The bot supports manual capture, pasted messages, CSV uploads, review prompts, queries, budgets, alerts, and settings deep links.
- FR-18.7 Until shared ledgers are implemented, group-chat requests are rejected without exposing personal ledger data.
- FR-18.8 Outbound messages have durable delivery-attempt records.

## 11. WhatsApp

### FR-19 WhatsApp channel **[WHATSAPP]**

- FR-19.1 WhatsApp uses Meta's supported Business Platform integration.
- FR-19.2 WhatsApp identity links to the same user and ledger as web and Telegram.
- FR-19.3 Incoming events and message-status events are idempotent.
- FR-19.4 Free-form replies respect the active customer-service window.
- FR-19.5 Proactive messages outside that window use approved templates.
- FR-19.6 Consent, template category, delivery state, quality signals, and per-message cost are recorded.
- FR-19.7 Users can choose privacy-preserving proactive templates.
- FR-19.8 Media retrieval is authenticated, size-limited, scanned, and copied into controlled storage before processing.
- FR-19.9 WhatsApp does not enter its bounded cohort until the initial controlled cohort produces an explicit decision to continue and channel-specific cost is observable; this does not imply that broader business-signal metrics have passed.

## 12. Analytics, quality, and operations

### FR-20 Product analytics **[CORE]**

The product records, without placing financial contents in analytics payloads:

- onboarding started and completed;
- channel linked;
- first real transaction;
- import started, completed, partially completed, and failed;
- review-item outcomes;
- categorization correction and rule creation;
- query class and outcome;
- budget and notification actions;
- export and deletion lifecycle;
- active-user and cohort retention;
- model usage and cost;
- notification selection, delivery, failure, suppression, and opt-out.

### FR-21 Operator capabilities **[CORE]**

- FR-21.1 Operators can inspect health, queue depth, error rates, delivery failures, model cost, and import-quality aggregates without casually accessing transaction contents.
- FR-21.2 Sensitive support access is explicit, time-bounded, and audited.
- FR-21.3 A global kill switch can stop expensive model work and proactive notifications independently.
- FR-21.4 Before external real-data use, the selected production recovery path has passed restoration against approved recovery objectives.
- FR-21.5 Production capacity has measured headroom for the controlled-cohort load profile and documented provider limits.

## 13. Research-gated capabilities

The [Product Document's deferred scope and research interpretation](./xpensego-product-doc.md#8-explicitly-deferred) own the evidence gates. These identifiers reserve traceability without committing delivery:

| Requirement                           | Status            | Constraint if later promoted                                                                              |
| ------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| FR-22 Shared ledgers                  | **[POST-SIGNAL]** | Requires an approved experiment covering isolation, personal rollups, and acquisition or retention value. |
| FR-23 Recurring-expense detection     | **[POST-SIGNAL]** | Requires sufficient longitudinal data and user confirmation of candidates.                                |
| FR-24 Tax-oriented exports            | **[POST-SIGNAL]** | Requires direct demand evidence and must not imply tax correctness.                                       |
| FR-25 Account Aggregator connectivity | **[POST-SIGNAL]** | Begins with partner, regulatory, consent, coverage, and unit-economics discovery.                         |
| FR-26 Deferred expansion              | **[HOLD]**        | Remains outside committed scope until the product authority changes.                                      |

## 14. Non-functional requirements

### Security and isolation

- All user and ledger scope is injected from authenticated server context.
- Secrets are managed outside source control.
- Webhook signatures or platform secrets are verified.
- Authorization tests cover every read, mutation, export, and destructive flow.
- Financial contents do not appear in application logs, product analytics, or exception messages by default.

### Reliability and idempotency

- Every external event and job has a stable idempotency key.
- Retried domain operations converge on one state. External provider attempts retry only after a known-transient failure or when proven provider idempotency makes the retry safe; ambiguous outcomes are reconciled or surfaced.
- An accepted event is persisted before acknowledgement where the channel permits it.
- Outbound selection, attempt, provider acceptance, delivery where observable, and outcome-unknown are distinct states.

### Auditability

- Source records are immutable.
- Corrections and destructive actions retain a content-minimized audit trail.
- Prompt, rule, parser, and model versions are attributable.

### UX latency budgets

These figures are initial experience budgets, not finalized service-level objectives. Before invitation, each budget is assigned a percentile, measured against a documented controlled-cohort load profile, and evidenced in production-shaped staging.

- A normal web ledger request reaches useful content within two seconds under the controlled-cohort load profile.
- A simple Telegram manual-log confirmation is visible to the user within five seconds when no asynchronous import is required. Webhook acknowledgement is a separate transport obligation and does not wait for that response.
- Long imports acknowledge immediately and expose progress.
- Supported money queries complete within eight seconds under the controlled-cohort load profile.

### Accessibility and mobile use

- Core web workflows meet WCAG 2.2 AA expectations.
- Ledger review, imports, correction, budgets, export, and deletion are usable on a mobile browser.

## 15. Evaluation and release gates

The maintained evaluation suite includes:

- manual logging in English and Hinglish;
- target bank and UPI message formats;
- CSV variants;
- duplicate and idempotency cases;
- categorization-rule learning;
- correction and undo;
- supported query classes;
- cross-user isolation;
- notification idempotency and failure recovery;
- export and permanent deletion;
- Telegram end-to-end flows.

Release and roadmap decisions use the [Product Document's success gates](./xpensego-product-doc.md#11-success-gates). The [Delivery Checklist](./CHECKLIST.md) owns the evidence sequence. No **[CORE]** requirement is release-complete until its behavior, non-functional requirements, and production-shaped evidence are linked.

## 16. Open requirements

Product-level decisions, including pricing and category-product policy, live in the [Product Document](./xpensego-product-doc.md#14-open-product-decisions).

- Exact email-verification, password-reset, recovery-delivery, and recent-reauthentication experience within the selected Better Auth architecture.
- Import file-size and row-count limits after performance measurement.
- Undo retention and source-record retention periods.
- The initial notification-detail default.
- Percentiles and the controlled-cohort load profile for the UX latency budgets; these are invitation-blocking decisions.
