# Telegram staging evidence

**Date:** 2026-08-03
**Environment:** `xpensego-staging` / `xpensego-api-staging` / `xpensego-platform-jobs-staging`
**Scope:** provider-backed Telegram webhook, duplicate ingress, asynchronous processing, explicit rejection, and operator recovery. This report does not claim transaction capture or external-user readiness.

## Provisioned provider boundary

- BotFather bot identity: `@xpensego_staging_bot` (`XpenseGo Staging`).
- Registered HTTPS webhook: `https://xpensego-api-staging.vaibhav21296.workers.dev/v1/channels/telegram/webhook`.
- Telegram `getWebhookInfo` reported the registered URL, `allowed_updates = ["message"]`, zero pending updates, and no last delivery error.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` exist only as staging Worker secrets. A request carrying a deliberately invalid webhook secret returned `401 {"ok":false,"error":"unauthorized"}` before database work.

## Duplicate and explicit-rejection proof

A controlled private-text update with synthetic Telegram identifiers was posted through the deployed authenticated webhook. The first request returned `200 accepted`; two exact replays returned `200 duplicate`.

Neon retained one inbound row for external event `910000000000001`. It reached `processed / unscoped_reply_created` with one processing attempt and created one outbound reply. A subsequent dispatcher pass sent that reply through the real Bot API to the deliberately nonexistent synthetic chat. Telegram explicitly rejected it with HTTP 400, and the durable records converged on:

- outbound message `2f9fc5de-2b87-415e-b8e2-af0290eeca80`;
- one provider attempt;
- message and attempt status `terminal_failure`;
- safe error code `telegram_http_400`;
- terminal timestamp `2026-08-03 08:24:39.624172+00`.

No real account identifier, message content, bot token, or webhook secret is copied into this report.

## Outcome-unknown and recovery policy

An `outcome_unknown` provider call is never sent again automatically or through operator recovery because Telegram cannot prove whether the original call was accepted. The deterministic provider-contract and PostgreSQL suites cover network ambiguity, malformed success responses, expired attempt leases, and duplicate suppression; ambiguity was not deliberately induced against Telegram staging because doing so could create an unobservable duplicate.

Explicit `terminal_failure` is recoverable only through the `Recover Telegram delivery` GitHub Actions workflow after an operator has corrected and reviewed the cause. The workflow requires:

- the exact outbound message UUID and current safe error code;
- one allow-listed recovery reason and the literal confirmation `recover`;
- a run-derived idempotency key;
- the separately secured staging migration URL and a Cloudflare API token limited to Queue writes.

The administrative PostgreSQL transaction refuses `provider_accepted`, `outcome_unknown`, mismatched errors, active records, and records at the three-attempt ceiling. It writes an audit row before reusing the existing content-minimized outbox job. A repeated workflow run is idempotent; an uncertain Queue publication may enqueue a duplicate job, but the provider-attempt claim still permits only one Bot API call. The Worker runtime role has no access to the recovery table.

[Managed migration run 30799638816](https://github.com/Vaibtan/XpensGo/actions/runs/30799638816) applied `0010_telegram_delivery_recovery` to staging from revision `26916c3365b620198d64618981c8448bd854fdd9`. A direct Neon verification found the recovery table present and `has_table_privilege('xpensego_runtime', 'telegram_delivery_recoveries', 'SELECT') = false`.

## Open acceptance evidence

- Send a real private `hello` message to `@xpensego_staging_bot` and retain the durable `provider_accepted` record plus the visible bot reply.
- Configure the least-privilege Queue API token and run the recovery workflow once against the controlled terminal record above.

Until both observations are recorded, real provider acceptance and live operator recovery remain open even though the deterministic implementation is complete.
