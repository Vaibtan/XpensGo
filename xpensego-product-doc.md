# Xpensego — Product Document v1.4

**Status:** Post-hackathon product direction
**Updated:** 31 July 2026
**Companion documents:** [PRD](./PRD.md) · [Technical Specification](./SPEC.md) · [Delivery Checklist](./CHECKLIST.md) · [Feature Opportunity Map](./FEATURE-RESEARCH.md)

This document owns the product thesis, target user, scope boundaries, business model, risks, roadmap, and validation gates. The PRD owns testable behavior, the Technical Specification owns implementation constraints, and the Delivery Checklist owns sequencing and evidence.

## 1. Product thesis

Xpensego is a chat-native expense product that turns transaction records a user already has into a trustworthy, categorized ledger. A user can paste a bank or UPI message, upload a CSV statement, or describe a transaction in ordinary language; Xpensego organizes it, lets the user correct it, answers questions about it, and sends only the alerts the user has requested.

The product is not merely a Telegram bot and it is not a dashboard-first finance application. Messaging provides low-friction capture and answers. The web application provides the control and trust surface: review, correction, imports, budgets, settings, export, and deletion.

**Positioning:** *Your bank already tells you everything. Xpensego makes it mean something.*

## 2. Problem

Indian consumers generate abundant transaction data through UPI, cards, bank messages, and statements, but that data rarely becomes a ledger they trust.

Automatic trackers reduce entry effort but often collapse distinct spending into broad or incorrect categories. Manual trackers provide control but demand a habit that is difficult to sustain. When a ledger is incomplete or wrong, its reports and alerts quickly become irrelevant.

Xpensego's hypothesis is that a useful product can combine:

1. Low-friction, user-initiated capture from records the user already has.
2. Classification that learns from corrections.
3. A visible review path that makes the ledger trustworthy.
4. Answers and alerts delivered through channels the user already uses.

The unresolved business question is whether this improvement is valuable enough to create durable usage and willingness to pay.

## 3. Target user

The first target is a digitally fluent Indian consumer who:

- primarily transacts through UPI and cards;
- has abandoned at least one expense tracker;
- wants answers and warnings more than a complex finance dashboard;
- is willing to paste transaction messages or periodically upload a CSV statement;
- values control over how their financial records are categorized and retained.

Small-business and GST-oriented use cases remain a pivot option. They are not a parallel first-release persona.

## 4. Core product loop

The product succeeds only if this loop repeats:

1. **Supply records:** the user logs a transaction, pastes one or more transaction messages, or uploads a CSV statement.
2. **Normalize:** Xpensego extracts transactions, preserves their source records, detects likely duplicates, and assigns categories.
3. **Review:** the user sees what was understood, corrects mistakes, and resolves uncertain records.
4. **Learn:** corrections create categorization rules that improve future imports.
5. **Use the ledger:** the user asks questions, reviews spending, or monitors budgets.
6. **Return for value:** a useful answer or requested alert gives the user a reason to keep the ledger current.

Capture without review creates an untrusted ledger. Insights without repeated capture become stale. Both halves of the loop are core.

## 5. Product surfaces and channels

This section assigns each surface a product role. Detailed behavior belongs to the linked PRD requirements.

### Web application

The web application is the authoritative control and trust surface for onboarding, review, correction, settings, data rights, and deeper ledger use. See the [web requirements](./PRD.md#9-web-application).

### Telegram

Telegram is the first messaging channel because it supports rapid product iteration with relatively little platform friction. It participates in the same core loop rather than operating as a separate reduced product. See the [Telegram requirements](./PRD.md#10-telegram).

### WhatsApp

WhatsApp is the second messaging channel and reuses the same product capabilities through a channel adapter. It is sequenced after the initial controlled cohort produces an explicit decision to continue; passing that decision does not imply that the broader business-signal gate has passed. See the [WhatsApp requirements](./PRD.md#11-whatsapp).

No messaging channel can access the user's device inbox. Transaction records are supplied deliberately by the user.

## 6. Product principles

1. **Trust before intelligence.** Every imported transaction can be traced to a source record and corrected.
2. **The user owns the data.** Isolation, export, and permanent deletion are product capabilities, not support procedures.
3. **Corrections compound.** A correction should reduce future correction effort.
4. **The model is not the authority.** Identity, ledger access, arithmetic, data mutation, and deletion constraints are enforced outside the model.
5. **One product across surfaces.** Web, Telegram, and later WhatsApp share one user and one ledger.
6. **Low-friction capture, optional control.** Messaging is fast; the web application is available when deeper review is needed.
7. **Proactive contact is earned.** Alerts require explicit consent, are useful rather than promotional, and respect channel rules.
8. **Projections disclose their limits.** Xpensego does not present incomplete financial records as financial advice or certainty.
9. **Measure before monetizing.** Pricing follows observed usage, cost, and willingness-to-pay evidence.

## 7. Initial product scope

The invite-ready core is the PRD's **[CORE]** requirement set. At product level, it covers:

- one personal ledger across the web application and Telegram;
- deliberate capture through manual entry, pasted transaction messages, and CSV statements;
- traceable imports, review, correction, categorization rules, and ledger control;
- structured questions, monthly budgets, and consented alerts;
- export, permanent deletion, product measurement, and safe operation.

The [PRD](./PRD.md) is authoritative for the individual behaviors and acceptance conditions.

## 8. Explicitly deferred

These are not part of the initial controlled-cohort scope:

- WhatsApp;
- shared ledgers and expense splitting;
- recurring-expense detection;
- affordability projections;
- tax-specific bundles;
- Account Aggregator connectivity;
- receipt OCR and voice logging;
- automatic device SMS access;
- investments, loans, credit scores, insurance, or net-worth tracking;
- PDF statement ingestion;
- production payment collection.

Schema and module decisions may preserve room for a known later capability, but deferred behavior is not implemented speculatively.

## 9. Research interpretation

`FEATURE-RESEARCH.md` provides useful evidence, not an automatic build order.

- Splitwise dissatisfaction justifies testing shared ledgers; it does not yet prove cross-sell into paid personal finance.
- Recurring detection is valuable only after users produce reliable longitudinal data.
- "Can I afford this?" must be framed as a projection based on available records, not a verdict.
- Account Aggregator connectivity is strategically interesting but depends on partnership, regulatory, cost, and consent constraints.
- Tax exports need direct user validation before they become committed scope.
- Receipt OCR, voice input, investments, and net-worth expansion remain on hold.

## 10. Business model

Pricing remains intentionally undecided.

The working monetization boundary is:

- **Free foundation hypothesis:** capture, review, correction, basic ledger access, export, and deletion. Final packaging remains an evidence-driven decision.
- **Potential paid value:** advanced intelligence, automation, projections, longer analytical history, premium notification workflows, and costly external integrations.

Before payment collection is implemented, Xpensego must have:

1. Measured cost per active user and per major workflow.
2. Evidence that users keep their ledgers current.
3. Evidence that users repeatedly use queries, alerts, or review features.
4. Direct willingness-to-pay conversations and a testable tier hypothesis.
5. Clear entitlements that do not remove a capability users were previously promised for free.

## 11. Success gates

### Product-quality gate

- Known transaction-message formats meet the agreed extraction evaluation target.
- Critical amounts, transaction direction, and dates are never silently invented.
- Cross-user isolation and destructive data flows pass end-to-end tests.
- Every low-confidence or duplicate import reaches review instead of silently corrupting the ledger.

### Invite-readiness gate

- The product-quality gate passes against production-shaped infrastructure.
- Critical isolation, authorization, export, deletion, and consent flows pass end to end.
- Production recovery, capacity, and cost controls satisfy the [Technical Specification's external-user requirements](./SPEC.md#16-deployment-topology) and are evidenced by the [Delivery Checklist](./CHECKLIST.md). No external user supplies real financial data before that evidence passes.
- Monitoring, cost controls, operational runbooks, and independent kill switches for model work and proactive notifications are operational.

### Initial controlled-cohort outcome

- Before invitation, define the cohort observation window, minimum interview count, quality and cost thresholds, and safety stop conditions.
- Only after invite readiness passes, invite 10–15 users and require at least 10 to complete the real onboarding flow before the cohort decision.
- Activation and time-to-first-value are measured.
- Import success, correction rate, "Other" share, query use, and alert delivery are observable.
- Users can export and permanently delete their data without manual operator intervention.
- The evidence produces an explicit decision to continue, narrow, pivot, or stop. A continue decision is the prerequisite for the bounded WhatsApp phase.

### Business-signal gate

This broader gate follows the controlled-cohort decision. Its validation period, activation denominator, and qualifying week-two contribution event are defined before measurement begins. The working signals are:

- 50 or more real users without paid acquisition during the first validation period;
- at least 40% of activated users supplying transactions again in week two;
- measured cost per active user;
- at least 10 structured user conversations about categorization quality, trust, and willingness to pay.

If week-two contribution falls below 15% and interviews show indifference to ledger accuracy, the B2C thesis should be reconsidered before expanding the roadmap.

Passing this broader gate is not implied by a controlled-cohort decision to continue. It remains required before **[POST-SIGNAL]** product expansion.

## 12. Risks

**Demand risk:** Better categorization may be appreciated but not paid for.

**Behavior risk:** Pasting records is still a habit; an incomplete ledger loses value.

**Trust risk:** A single silent duplicate, wrong amount, or privacy surprise can outweigh many correct classifications.

**Channel risk:** Telegram is easy to build but has lower reach in India; WhatsApp has higher reach but greater policy, approval, and cost constraints.

**Moat risk:** The individual features are reproducible. Defensibility must come from accumulated user corrections, trust, workflow quality, and eventually privileged ingestion partnerships.

**Cost risk:** Model and WhatsApp costs can undermine low-price consumer subscriptions.

**Scope risk:** Research opportunities can distract from completing and validating the core loop.

**Platform risk:** The Cloudflare-native architecture lowers operational burden but introduces runtime constraints, hard limits, and provider-specific failure modes. The accepted infrastructure policies live in the [Technical Specification](./SPEC.md) and [ADRs](./docs/adr/); the Delivery Checklist must evidence them before external real-data use.

## 13. Roadmap

1. **Foundation:** establish the smallest production-shaped technical foundation required by the [Technical Specification](./SPEC.md) for the first vertical slice.
2. **Invite-ready core:** capture, imports, review, categorization rules, queries, budgets, alerts, data rights, and the invite-readiness evidence.
3. **Initial controlled cohort:** run the approved cohort, review product and operating evidence, and make the controlled-cohort decision.
4. **WhatsApp channel after a continue decision:** Cloud API integration, templates, consent, delivery tracking, and cost controls.
5. **Broader business validation:** expand the measured cohort, complete pricing research, and evaluate the business-signal gate.
6. **Post-signal roadmap:** promote only deferred capabilities whose product and evidence gates pass.

The [Delivery Checklist](./CHECKLIST.md) owns the executable phase and dependency breakdown.

## 14. Open product decisions

- The exact initial category taxonomy and customization policy.
- Whether the first web conversational experience is a full chat surface or contextual queries from ledger views.
- The product thresholds that graduate WhatsApp from implementation to public availability.
- Pricing tiers and entitlements.
- Whether shared ledgers become an acquisition feature, a retention feature, or remain out of scope.
- The evidence required to pursue the small-business/GST pivot.
