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

The replacement implementation has started under `apps/` and `packages/`. It currently contains the pinned Next.js/OpenNext web shell, an Effect-based API Worker with real `fetch` and Queue execution boundaries, versioned contracts, validated runtime configuration, content-minimized correlation/job telemetry, strict shared tooling, and Worker-runtime tests. Secret-backed configuration is intentionally deferred until the first operation that consumes it. Neon/Hyperdrive persistence, authentication, outbox recovery, Telegram behavior, and deployed staging evidence remain Phase 1 and Phase 2 work; the local tracer is not a user-ready product.

The Python bot, local SQLite database, and original D1 Cloudflare Worker remain hackathon experiments. They are useful as behavioral references and test fixtures but are not reused as the production runtime. Legacy artifacts should remain intact until the replacement reproduces the intended behavior and any retained data has been audited.

The waitlist site and its setup material are separate acquisition assets. The root `SETUP.md` and `XpensGo Waitlist/` directory apply to that waitlist, not to the new application runtime.

## Delivery order

1. Align product and technical documentation.
2. Establish the smallest production-shaped foundation required by the first vertical slice.
3. Deliver one complete Telegram-to-ledger-to-web slice.
4. Add imports, review, queries, budgets, alerts, data rights, and each capability's infrastructure just in time.
5. Pass invite readiness, run the 10–15-user controlled cohort, and make an explicit continue, narrow, pivot, or stop decision.
6. After a continue decision, add WhatsApp through the established channel seam while broader business validation continues.
7. Build post-signal capabilities only after their explicit gates pass.
