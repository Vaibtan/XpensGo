---
status: accepted
date: 2026-07-30
---

# Use Cloudflare Workers and Effect for the production backend

Xpensego will deploy its Next.js application to Cloudflare Workers through OpenNext and implement backend behavior as Effect-based TypeScript programs executed from Cloudflare Worker entrypoints. Managed PostgreSQL remains the system of record and is reached from Workers through Hyperdrive; Cloudflare Queues, Workflows, Cron Triggers, and R2 provide asynchronous, durable, scheduled, and object-storage capabilities.

## Considered options

- A NestJS modular monolith running in a conventional Node.js host.
- NestJS in Cloudflare Containers behind a Worker.
- A Cloudflare-native Worker backend using Effect without NestJS.

The Cloudflare-native option was selected because the product is dominated by short HTTP requests, messaging webhooks, asynchronous jobs, schedules, and file processing. NestJS would duplicate Effect's dependency, lifecycle, and error models, while Containers would add a second compute lifecycle before the product has evidence that it needs one.

## Consequences

- NestJS, Cloudflare Containers, and D1 are not part of the initial production architecture.
- Domain services remain modular and depend on interfaces rather than Cloudflare bindings so the business model is testable and not coupled to entrypoints.
- Queue delivery is treated as at least once; every external event and job is idempotent, and database-to-queue handoff has a recoverable outbox path.
- Effect retries and concurrency apply only within an execution attempt. Work that must survive termination uses Queues or Workflows.
- Schema migrations use a direct administrative PostgreSQL connection; application traffic uses Hyperdrive where compatible.
- Phase 1 proves OpenNext, the Effect Worker boundary, Neon/Hyperdrive, and one recoverable Queue/outbox path. Workflows, Cron Triggers, and R2 are proven just in time by the first capability that needs them.
- The Cloudflare plan used for external real-data invitations is selected from measured capacity, retention, and hard-limit evidence rather than free-tier availability.
