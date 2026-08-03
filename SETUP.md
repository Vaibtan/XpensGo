# Xpensego setup

The repository root is now the replacement TypeScript workspace. Start with
[README.md](./README.md) for its install, validation, and application commands.

The existing Convex/Cloudflare Pages waitlist remains a legacy, separately
packaged artifact while the replacement product is built. Its operational setup
is documented once in
[XpensGo Waitlist/SETUP.md](./XpensGo%20Waitlist/SETUP.md). Run those commands
from the `XpensGo Waitlist` directory.

Do not treat the waitlist, Python bot, or hackathon Worker as evidence that the
replacement application is production-ready.

## Managed development and staging resources

The replacement API uses separate Neon projects and Cloudflare resources for
development and staging.

| Environment | Neon project / branch                             |
| ----------- | ------------------------------------------------- |
| Development | `winter-base-57387476` / `br-orange-lab-azj04ouj` |
| Staging     | `rough-term-42024311` / `br-spring-mud-azz6ko90`  |

The API's [Wrangler configuration](./apps/api/wrangler.jsonc) is the sole source
of truth for Hyperdrive identifiers, Queue names, and environment bindings.

The deployed Workers are
[`xpensego-api`](https://xpensego-api.vaibhav21296.workers.dev) and
[`xpensego-web`](https://xpensego-web.vaibhav21296.workers.dev) for development,
and
[`xpensego-api-staging`](https://xpensego-api-staging.vaibhav21296.workers.dev)
and
[`xpensego-web-staging`](https://xpensego-web-staging.vaibhav21296.workers.dev)
for staging. These `workers.dev` routes are smoke-tested as Phase 1 evidence;
custom domains remain out of scope.

Each Hyperdrive configuration uses the environment's direct, non-pooler Neon
endpoint as `xpensego_runtime`, with SQL response caching disabled. Cloudflare
owns the runtime credential; it is not duplicated in Worker secrets or the
repository. Migrations use `xpensego_migrator` over a direct connection with
`sslmode=verify-full`. Those URLs are stored only as the encrypted GitHub
repository secrets `XPENSEGO_MIGRATION_DATABASE_URL_DEVELOPMENT` and
`XPENSEGO_MIGRATION_DATABASE_URL_STAGING`. The
[managed migration workflow](./.github/workflows/managed-migrations.yml) maps
the selected secret to `XPENSEGO_MIGRATION_DATABASE_URL`; application deploys
never run migrations implicitly.

The verified staging deploy is `npm run deploy:staging:verified`. It rejects
uncommitted deployment inputs, deploys both Workers from one Git revision, and
stamps that revision into both runtimes. The
[Phase 1 acceptance workflow](./.github/workflows/phase1-staging-proof.yml)
additionally uses `XPENSEGO_PHASE1_PROBE_SECRET` and the project-scoped
`XPENSEGO_NEON_API_KEY_STAGING`. The probe signing secret exists only in the
staging API Worker. Secret values must not be copied into local files, workflow
inputs, logs, or documentation. See the
[Phase 1 staging report](./docs/evidence/phase1-staging.md) for the completed
provider-backed proof.

## Telegram Worker configuration

The API Worker reads two environment-specific secrets and one public setting:

- `TELEGRAM_WEBHOOK_SECRET` authenticates Telegram webhook requests.
- `TELEGRAM_BOT_TOKEN` authorizes outbound Bot API calls.
- `TELEGRAM_BOT_USERNAME` is the public BotFather username used to construct one-use onboarding deep links. It is committed in the environment-specific `vars` within `apps/api/wrangler.jsonc`; staging uses `xpensego_staging_bot`, while development leaves the value empty until it has a separate bot.

Set both secrets through Wrangler's interactive prompt; never place either value in a command argument, local environment file, GitHub Actions variable, or committed configuration. From the repository root, configure staging with:

```powershell
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --env staging --config apps/api/wrangler.jsonc
npx wrangler secret put TELEGRAM_BOT_TOKEN --env staging --config apps/api/wrangler.jsonc
```

Omit `--env staging` only when intentionally configuring the separate development Worker. The staging webhook is registered at `https://xpensego-api-staging.vaibhav21296.workers.dev/v1/channels/telegram/webhook`; provider observations and remaining acceptance work are recorded in the [Telegram staging report](./docs/evidence/telegram-staging.md).

## Telegram terminal delivery recovery

The `Recover Telegram delivery` GitHub Actions workflow is the only managed recovery path for an explicitly rejected Telegram reply. It uses the existing `XPENSEGO_MIGRATION_DATABASE_URL_STAGING` secret and additionally requires `XPENSEGO_CLOUDFLARE_QUEUE_API_TOKEN_STAGING`, a Cloudflare API token scoped to this account with only **Queues Write** permission. Do not use a global API key or reuse the bot/webhook credentials.

Before running the workflow:

1. Apply all managed staging migrations, including `0010_telegram_delivery_recovery`.
2. Correct and review the cause of the explicit provider rejection.
3. Read the terminal outbound message UUID and safe `last_error_code` from the staging delivery record.
4. Dispatch `Recover Telegram delivery` with that UUID, the exact error code, an allow-listed reason, and confirmation `recover`.

The workflow derives an idempotency key from its GitHub run. Re-running the same workflow run is safe. Starting a new run authorizes another provider call only while the message is still `terminal_failure` and below the normal three-attempt ceiling. `provider_accepted`, `outcome_unknown`, mismatched errors, and exhausted records are always refused. Recovery uses the direct administrative database URL and Cloudflare Queue API outside the Worker; the runtime database role has no access to recovery records.
