---
status: accepted
date: 2026-07-31
---

# Use Effect SQL with node-postgres and forward-only migrations

Xpensego will use `@effect/sql` with `@effect/sql-pg` as its PostgreSQL query
layer. The adapter uses the `pg` backend selected by Effect SQL, and schema
changes run through Effect SQL's forward-only migrator over a direct
administrative PostgreSQL connection.

## Considered options

- Drizzle ORM with Drizzle Kit migrations.
- Raw `node-postgres` with a separate migration CLI.
- Effect SQL with its PostgreSQL adapter and migrator.

Effect SQL was selected because it preserves one typed Effect resource,
transaction, error, and tracing model without adding an ORM abstraction before
the domain has query-shape evidence. Its PostgreSQL adapter uses `pg`, which is
compatible with Cloudflare Hyperdrive, and its scoped Layer owns pool cleanup.

## Boundaries

- Application services depend on narrow, application-owned persistence ports.
- PostgreSQL rows, SQL, driver failures, and constraint codes remain inside the
  adapter package and are translated into domain-shaped outcomes or typed
  failures.
- Worker invocations construct and close a scoped PostgreSQL Layer from the
  invocation's Hyperdrive connection string. No pool or client is retained in
  module-global state.
- Migrations use a separately secured direct connection and never run inside a
  Worker request.
- Each migration grants the runtime role only the table operations required by
  implemented application adapters; future tables receive no blanket default
  privileges.
- Migrations are forward-only TypeScript Effect programs. Production recovery
  uses a corrective forward migration or the separately tested database restore
  process; application deploys do not attempt automatic down migrations.

## Consequences

- `@effect/sql`, `@effect/sql-pg`, and their compatible Effect peers are pinned
  in the workspace lockfile; PostgreSQL 17 is pinned in the Compose image.
- Tests use real PostgreSQL rather than an in-memory repository whenever
  transaction or constraint behavior matters, both locally and in CI once the
  database workflow is enabled there.
- The first migration establishes only ownership, inbound idempotency, and the
  transactional outbox records needed for the Phase 1 proof. Broader Phase 2
  tables are added with the feature that owns them.
- Authentication schema ownership was subsequently resolved by [ADR 0004](./0004-better-auth-effect-http-api.md).
