# Xpensego Cloudflare Worker

This is the Cloudflare-native runtime replacing Python long polling, local SQLite, and APScheduler:

- `POST /telegram` is the Telegram webhook.
- Cloudflare D1 is the ledger store.
- The Cron Trigger invokes the daily alert check at 20:00 IST (`30 14 * * *` UTC).
- Telegram sends are direct Bot API calls from the Worker.

## One-time deployment

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

## Local development

Use Wrangler's remote D1 mode only with non-production data:

```bash
npm run dev -- --remote
```

For normal local development, create a local D1 database through Wrangler and use `npm run dev`.

## Current worker scope

The worker provides the Cloudflare transport, D1 schema, authenticated webhook, onboarding, basic manual expense/credit logging, budgets, and scheduled alerts. Advanced conversational tool-calling, bulk SMS/CSV parsing, payee teaching, corrections, and reports must be ported from the Python implementation before treating this as feature-parity production migration.
