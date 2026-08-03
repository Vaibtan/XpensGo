# Telegram adapter local evidence

**Date:** 2026-08-02
**Scope:** deterministic local implementation evidence for the Telegram webhook, asynchronous processing, and outbound-reply adapter. This report does not claim webhook registration or real Telegram Bot API acceptance.

## What is implemented

- The Worker exposes `POST /v1/channels/telegram/webhook`, validates the configured `X-Telegram-Bot-Api-Secret-Token` with a constant-time comparison before reading the body, and returns safe bounded errors.
- The boundary reads at most 64 KiB, tolerates additive provider fields, accepts private text plus `/link` and `/unlink`, and acknowledges authenticated but unsupported group or non-text updates without retaining their contents.
- One-use challenge material is replaced with its SHA-256 digest before persistence. Raw link and unlink tokens are never written to PostgreSQL.
- `update_id` converges through a unique database constraint. The normalized inbound event and `channel.event.received.v1` outbox record are committed in one transaction before the webhook acknowledges acceptance.
- Queue processing holds a durable lease, applies persisted per-external-account and system-wide minute windows once per event, resolves User, personal Ledger, and active Channel Identity from server-held relationships, and then enforces one persisted User window across all of that User's linked Telegram identities.
- Linked ordinary text is stored as a normalized channel command. Until transaction capture is implemented, it produces the explicit semantic `CaptureUnavailable` reply; unlinked text produces `LinkRequired`.
- Authenticated web challenges expose a BotFather-username deep link whose `/start link_<token>` or `/start unlink_<token>` payload normalizes to the same one-use command as manual entry.
- Semantic reply intents and `channel.reply.requested.v1` outbox records are committed before provider delivery. The Telegram renderer owns channel wording, content protection, disabled previews, and the trusted workspace deep link.
- A delivery attempt is inserted before calling `sendMessage`. Explicit acceptance, transient rejection, terminal rejection, and ambiguous outcome are separate durable states. Network rejection, invalid success payloads, and expired in-flight leases become terminal `outcome_unknown` and are never sent again automatically.

The development and small-alpha abuse defaults are 30 accepted events per external Telegram account per minute, 30 events per resolved User per minute across linked identities, and 300 system-wide events per minute. Explicit transient provider rejections receive at most three provider attempts. These are implementation defaults, not validated production capacity.

## Evidence exercised

The deterministic suites cover:

- webhook secret rejection before Hyperdrive access, additive payload decoding, malformed commands, body limits, private/group safety, and raw-token redaction;
- concurrent ingress redelivery converging on one event and one dispatch;
- concurrent processing claims converging on one active lease;
- server-side linked-identity resolution, normalized-command creation, and reply-outbox creation in real PostgreSQL transactions;
- persisted abuse suppression before Identity operations or reply creation;
- Telegram rendering and provider classification for acceptance, HTTP 429, HTTP 400, network rejection, and invalid provider responses;
- concurrent provider delivery claims, transient retry state, terminal acceptance, and `outcome_unknown` suppression in real PostgreSQL transactions;
- the Worker path from verified webhook through Queue processing to a published semantic reply outbox.

Validation commands:

```powershell
npm run check
npm run test:integration
```

## Remaining provider-backed work

- Apply migration `0009_telegram_processing` to the managed development and staging databases.
- Configure `TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_BOT_TOKEN` as secrets in each intended Worker environment. Keep the public `TELEGRAM_BOT_USERNAME` in environment-specific Wrangler `vars`; staging uses `xpensego_staging_bot`, and development deep links remain disabled until a separate bot exists.
- Register the staging webhook with Telegram and capture real secret-verification, delivery-acceptance, explicit rejection, and Queue-recovery evidence.
- Define an operator-authorized recovery procedure for terminal provider records. Automatic resend remains prohibited when prior acceptance is uncertain.
- Implement transaction parsing and ledger mutation. The current adapter deliberately does not imply that an accepted text message created an expense.
