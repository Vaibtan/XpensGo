# Xpensego

Xpensego is a chat-native expense product for Indian consumers. The post-hackathon product is being rebuilt around a web control surface, a channel-independent domain backend, and Telegram as the first messaging channel. WhatsApp follows after the core ledger and trust loop are validated.

## Target architecture

- Next.js App Router deployed to Cloudflare Workers through OpenNext.
- An Effect-based TypeScript backend deployed as Cloudflare Worker entrypoints; NestJS is not part of the target system.
- Neon Postgres as the system of record, reached from Workers through Hyperdrive.
- Cloudflare Queues for asynchronous delivery, Workflows for durable multi-step operations, Cron Triggers for schedules, and R2 for controlled files and exports.
- Telegram as the first messaging channel through a shared channel seam; WhatsApp follows only after the initial controlled cohort produces an explicit decision to continue.
- Neon Free is limited to development, staging, and small internal or controlled-alpha use without externally invited real financial data. Paid Neon and a successfully tested encrypted recovery path precede external real-data invitations; the Cloudflare plan follows measured capacity and hard limits.

## Documentation map

These documents have distinct responsibilities:

- [`xpensego-product-doc.md`](./xpensego-product-doc.md) — product thesis, positioning, business model, risks, and roadmap gates.
- [`PRD.md`](./PRD.md) — canonical user-facing requirements and release scope.
- [`SPEC.md`](./SPEC.md) — canonical technical architecture, module interfaces, workflows, and quality constraints.
- [`CHECKLIST.md`](./CHECKLIST.md) — ordered delivery plan and exit gates.
- [`CONTEXT.md`](./CONTEXT.md) — domain language used by product, design, and engineering.
- [`FEATURE-RESEARCH.md`](./FEATURE-RESEARCH.md) — market and feature evidence; an input to roadmap decisions, not committed scope.
- [`docs/adr/`](./docs/adr/) — accepted, durable architecture decisions and their consequences.

When documents conflict, product intent in the Product Document governs the PRD, the PRD governs user-facing behavior in the Technical Specification, and the Technical Specification governs the Checklist. ADRs record why durable technical decisions were made; accepting or superseding an ADR must update the Technical Specification in the same change rather than creating a competing source of truth. Feature research has no authority over committed scope.

## Current repository state

The replacement runtime under `apps/` and `packages/` has a provider-backed platform tracer plus identity and Telegram adapter foundations. The Next.js workspace resolves a Better Auth session into an application-owned User, personal Ledger, timezone, and visible Telegram link state through the Effect API. The staging Telegram webhook has Telegram-origin secret verification, duplicate ingress, asynchronous processing, real Bot API acceptance and explicit rejection, ambiguity suppression, and bounded live recovery evidence. Recovery is limited to explicit terminal failures; ambiguous or accepted calls cannot be requeued. See the [platform staging report](./docs/evidence/phase1-staging.md), [identity foundation evidence](./docs/evidence/identity-foundation.md), [local Telegram adapter evidence](./docs/evidence/telegram-adapter-local.md), and [Telegram staging evidence](./docs/evidence/telegram-staging.md). Recovery email, transactions, deployed identity acceptance, and production readiness remain open; this is not yet a user-ready product.

The Python bot, local SQLite database, and original D1 Cloudflare Worker remain hackathon experiments. They are useful as behavioral references and test fixtures but are not reused as the production runtime. Legacy artifacts should remain intact until the replacement reproduces the intended behavior and any retained data has been audited.

The waitlist site remains a separate acquisition asset with its own setup material under `XpensGo Waitlist/`. Root [`SETUP.md`](./SETUP.md) owns replacement-application environment and managed-resource setup and links to the legacy waitlist instructions when needed.

## Local PostgreSQL workflow

Docker provides the reproducible PostgreSQL 17 development database. The committed credentials are local-only and bind PostgreSQL to `127.0.0.1:55432`.

```powershell
npm ci
npm run db:up
npm run db:migrate
npm run test:integration
```

`npm run db:down` stops the database without deleting its named volume. Application code connects as `xpensego_runtime`; migrations use the separate `xpensego_migrator` connection. Neon and Hyperdrive credentials are not required for this local proof. Managed development and staging resource ownership is documented in [`SETUP.md`](./SETUP.md).

A publication that exhausts its bounded retry policy remains in a terminal database state for inspection. After resolving the underlying Queue or data issue, return exactly one message to the dispatcher with `npm run db:outbox:retry -- <outbox-message-id>`; managed environments require the separately secured direct `XPENSEGO_MIGRATION_DATABASE_URL` in the operator shell. Worker runtime credentials cannot invoke this recovery seam.

Telegram provider recovery is a separate, narrower operation. Only an explicit `terminal_failure` below the provider-attempt ceiling may be requeued through the audited `Recover Telegram delivery` workflow. `provider_accepted` and `outcome_unknown` are permanently non-replayable; see [`SETUP.md`](./SETUP.md#telegram-terminal-delivery-recovery).

## Delivery order

1. Align product and technical documentation.
2. Establish the smallest production-shaped foundation required by the first vertical slice.
3. Deliver one complete Telegram-to-ledger-to-web slice.
4. Add imports, review, queries, budgets, alerts, data rights, and each capability's infrastructure just in time.
5. Pass invite readiness, run the 10–15-user controlled cohort, and make an explicit continue, narrow, pivot, or stop decision.
6. After a continue decision, add WhatsApp through the established channel seam while broader business validation continues.
7. Build post-signal capabilities only after their explicit gates pass.
