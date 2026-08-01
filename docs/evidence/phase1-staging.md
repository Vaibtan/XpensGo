# Phase 1 staging evidence

**Status:** passed on 2026-08-01

This report owns the detailed evidence for the [Phase 1 checklist](../../CHECKLIST.md#phase-1--minimal-platform-tracer). It records what was actually exercised and separates provider-backed results from deterministic evidence and remaining work.

## Evidence chain

| Evidence                   | Result                                                                                                                                                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployed source            | Git revision `477e4d2792b5e42558f16173e5e05fca49e25779`; both staging Workers returned the same revision before acceptance                                                                                                                                                                         |
| Linux CI                   | [Run 30704849320](https://github.com/Vaibtan/XpensGo/actions/runs/30704849320) passed locked install, quality/build gates, 16 empty-PostgreSQL/Workerd integration tests, full-history secret scanning, and dependency policy                                                                      |
| Managed migrations         | [Staging run 30703367259](https://github.com/Vaibtan/XpensGo/actions/runs/30703367259) and [development run 30703955262](https://github.com/Vaibtan/XpensGo/actions/runs/30703955262) applied the forward-only sequence through migration `0006`; acceptance found zero pending staging migrations |
| Provider-backed acceptance | [Run 30704943776](https://github.com/Vaibtan/XpensGo/actions/runs/30704943776) passed against the deployed staging revision                                                                                                                                                                        |

## Local production-runtime preview

The built OpenNext artifact ran through Wrangler alongside the locally registered API Worker and local PostgreSQL. The Server Component route returned `200` with its expected rendered content; anonymous `/workspace` returned `307` to `/sign-in`; synthetic signup returned `200`; and the authenticated `/workspace` returned `200`, rendered only the fixture identity, and sent `no-store, must-revalidate, no-cache, max-age=0, private`. The synthetic user was deleted after the proof and a database check returned zero matching rows.

## Provider-backed results

- The OpenNext Worker served the explicitly dynamic `/workspace` route for two independent Better Auth sessions. Each response contained only its own synthetic user, both responses were `private, no-store`, and an anonymous request redirected to `/sign-in`.
- The staging Hyperdrive configuration used the `xpensego_runtime` role against the direct Neon endpoint with SQL response caching disabled. The managed path exercised the real Hyperdrive transaction and ownership constraints.
- Two concurrent deliveries of one synthetic inbound event produced one `Accepted` and one `Duplicate`; a cross-owner attempt produced `InboundEventOwnershipMismatch`. The database retained one inbound event and one outbox message.
- A deliberately seeded durable publication-failure state recovered through the real ten-minute Cron dispatcher, staging Queue, and Worker consumer in 38,635 ms. The message reached `published` after two publication attempts with one receipt and no remaining error code.
- A second real Queue publication increased observed delivery attempts from one to two while the unique receipt count remained one, proving duplicate-safe consumption.
- Neon reported `active`, then `idle` after the uninterrupted 360-second window using its effective 300-second suspend timeout, and then `active` after an authenticated Hyperdrive request. The complete cold request took 2,501 ms against a 10,000 ms bound.
- The primary staging Queue had exactly one API Worker producer and one API Worker consumer. The separate staging DLQ existed and had no consumer.

## Telemetry and safety

The live API tail observed ten successful provider invocations. Application logs contained one content-minimized publication-success event and two consumption events (`processed` and `duplicate`) with correlation and outbox identifiers. The deliberate concurrent uniqueness race also produced a warning containing only the operation and `SqlError` cause tag. No email, password, amount, currency, merchant, counterparty, description, or financial payload term appeared.

Cloudflare's restricted live-tail envelope included synthetic authorization and cookie header data that can contain secret values. This is provider-managed administrative telemetry, not an application-emitted field. The transient captures were reduced to the aggregate findings above and permanently deleted; no raw diagnostic is committed. Access, retention, and downstream-export controls for this provider surface remain a production gate.

## Evidence boundaries

- The staging recovery proves seeded durable failure state → real Cron → real Queue → real consumer. It does not claim that a Cloudflare Queue outage was induced.
- Deterministic Workerd tests separately prove per-message retry when outbox persistence is unavailable and verify the configured DLQ path. No real provider DLQ transition was induced in shared staging.
- All database, identity, and session fixtures were synthetic. Cleanup ran even on failure, and cleanup failure would fail the workflow.
- The local OpenNext preview proves the production adapter under local Wrangler and PostgreSQL, not the Cloudflare or Neon control planes; the managed staging run covers those provider paths separately.
- Recovery-email delivery, Telegram behavior, backups and restore, production capacity, threat-model closure, and external-user readiness remain later gates.
