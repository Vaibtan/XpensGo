# Telegram staging evidence

**Date:** 2026-08-03
**Environment:** `xpensego-staging` / `xpensego-api-staging` / `xpensego-platform-jobs-staging`
**Scope:** Telegram-origin authenticated webhook delivery, duplicate ingress, asynchronous processing, real Bot API acceptance and explicit rejection, and operator recovery. This report does not claim transaction capture or external-user readiness.

## Provisioned provider boundary

- BotFather bot identity: `@xpensego_staging_bot` (`XpenseGo Staging`).
- Registered HTTPS webhook: `https://xpensego-api-staging.vaibhav21296.workers.dev/v1/channels/telegram/webhook`.
- Telegram `getWebhookInfo` reported the registered URL, `allowed_updates = ["message"]`, zero pending updates, and no last delivery error.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` exist only as staging Worker secrets. A request carrying a deliberately invalid webhook secret returned `401 {"ok":false,"error":"unauthorized"}` before database work.
- Two Telegram-origin private events subsequently passed the same secret gate, reached durable `processed` state, and produced replies that the Bot API accepted with provider message identifiers. No external account, chat, update, or provider message identifier is retained in this report.

## Duplicate and explicit-rejection proof

A controlled private-text update with synthetic Telegram identifiers was posted through the deployed authenticated webhook. The first request returned `200 accepted`; two exact replays returned `200 duplicate`.

Neon retained one inbound row for external event `910000000000001`. It reached `processed / unscoped_reply_created` with one processing attempt and created one outbound reply. A subsequent dispatcher pass sent that reply through the real Bot API to the deliberately nonexistent synthetic chat. Telegram explicitly rejected it with HTTP 400, and the durable records converged on:

- outbound message `2f9fc5de-2b87-415e-b8e2-af0290eeca80`;
- one initial provider attempt;
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

[Recovery run 30802625710](https://github.com/Vaibtan/XpensGo/actions/runs/30802625710) exercised the managed path from revision `148ba7d635d60c5f082eb2ade2f67bd43fba702b`. Cloudflare accepted the content-minimized Queue job, Neon retained exactly one recovery audit row, and the controlled message advanced from one to two provider attempts. Because its synthetic recipient deliberately remained nonexistent, Telegram explicitly rejected the second call with the same `telegram_http_400`; the record returned to `terminal_failure` rather than an ambiguous state. This proves the bounded state transition and real provider call, not successful redelivery to a corrected recipient.

## Acceptance result

The staging gate is complete: Telegram-origin authenticated ingress, deduplication, asynchronous processing, real Bot API acceptance and explicit rejection, ambiguity suppression, and bounded live recovery are evidenced. Transaction capture and external-user readiness remain separate open gates.
