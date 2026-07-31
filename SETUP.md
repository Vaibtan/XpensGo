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
`XPENSEGO_MIGRATION_DATABASE_URL_STAGING`. A future migration workflow must map
the selected environment secret to `XPENSEGO_MIGRATION_DATABASE_URL` for the
migration command.
