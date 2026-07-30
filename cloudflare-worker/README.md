# Legacy hackathon Cloudflare Worker

> **Legacy — not the production foundation.** This D1-based Worker is a hackathon experiment preserved for behavioral reference only. Do not extend or deploy it as the replacement application. The current direction is documented in the [root README](../README.md), [Technical Specification](../SPEC.md), and [Delivery Checklist](../CHECKLIST.md).

This experiment replaced Python long polling, local SQLite, and APScheduler during the hackathon:

- `POST /telegram` is the Telegram webhook.
- Cloudflare D1 is the ledger store.
- The Cron Trigger invokes the daily alert check at 20:00 IST (`30 14 * * *` UTC).
- Telegram sends are direct Bot API calls from the Worker.

## Historical deployment reference

Do not run these commands against a production Cloudflare account. They remain only to explain how the hackathon artifact was operated.

From this directory:

```bash
npm install
npx wrangler login
npx wrangler d1 create xpensego-db
```

Copy the returned database ID into `wrangler.jsonc` in the `database_id` field. Run all Wrangler commands from `cloudflare-worker`; the canonical Worker configuration is `wrangler.jsonc` in that directory. Then apply the schema:

```bash
npx wrangler d1 migrations apply xpensego-db --remote
```

Store secrets. Never place these values in `wrangler.toml` or commit them:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put OPENAI_API_KEY
```

Deploy:

```bash
npm run check
npm run deploy
```

Wrangler returns a `https://<worker>.<account>.workers.dev` URL. Register the Telegram webhook manually, substituting your real values locally:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://<worker-url>/telegram" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
  -d "allowed_updates=[\"message\"]"
```

Verify:

```bash
curl https://<worker-url>/health
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

## Historical local development

Use Wrangler's remote D1 mode only with non-production data:

```bash
npm run dev -- --remote
```

For normal local development, create a local D1 database through Wrangler and use `npm run dev`.

## Hackathon worker scope

The worker provides the old Cloudflare transport, D1 schema, authenticated webhook, onboarding, basic manual expense/credit logging, budgets, and scheduled alerts. It does not establish feature parity or production readiness. The replacement uses new OpenNext and Effect Worker projects, Neon PostgreSQL through Hyperdrive, and the reliability boundaries defined by the canonical specification.
