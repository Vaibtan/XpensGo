---
status: accepted
date: 2026-07-30
---

# Use Neon as the managed PostgreSQL provider

Xpensego will use Neon for managed PostgreSQL rather than provisioning PostgreSQL directly on AWS or GCP. Neon preserves standard PostgreSQL behavior, supports low-cost scale-to-zero development, and has an officially documented Cloudflare Hyperdrive integration.

## Connection policy

- Worker application traffic uses a standard PostgreSQL driver through Hyperdrive.
- Hyperdrive receives a direct Neon endpoint, not Neon's pooled endpoint; combining both poolers is prohibited.
- Hyperdrive query caching is disabled for the initial product because authorization, financial state, and read-after-write behavior require fresh results.
- Database clients are created inside each Worker invocation rather than retained globally.
- Migrations and recovery operations use a separately secured direct Neon connection and a higher-privilege migration role.
- Production application credentials have only the permissions required by runtime use cases.

## Environment and cost policy

- Development, staging, and production use separate Neon projects. Short-lived Neon branches may be used for CI and preview environments.
- The Free plan is acceptable for development, staging, and a small internal or controlled alpha that does not invite external users to submit real financial data.
- Before any external user is invited to submit real financial data, production uses a paid Neon plan selected for measured capacity and recovery needs, and the selected encrypted backup and recovery path has been restored successfully. An independent backup is required when Neon's restore window cannot meet the recovery objectives.
- Database usage, storage, wake latency, recovery requirements, and support needs are monitored as explicit upgrade signals.
- Files and generated exports remain in R2; Neon stores their ownership and lifecycle metadata.

## Consequences

- Early production-shaped slices test scale-to-zero wake-up behavior, connection recovery, transactions, and migrations. Backup and restoration evidence is invitation-blocking but need not delay the first Telegram-to-ledger vertical slice.
- The production region is selected after measuring latency for Indian users and reviewing data-location implications; Singapore is the initial candidate where available.
- Current Neon plan limits and pricing are rechecked before scaffolding and before each release gate rather than copied indefinitely into architecture assumptions.
