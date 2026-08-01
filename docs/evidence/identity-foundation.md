# Identity and personal Ledger foundation

**Scope:** local implementation evidence for the first identity prerequisite slice. This report does not claim deployed-staging or Telegram-provider acceptance.

## Implemented boundary

- Better Auth owns credentials and sessions; its server API validates each private request with cookie caching disabled.
- The Identity module resolves a verified provider principal into one application User, one personal Ledger, and a server-constructed `ActorContext`.
- Users have a validated IANA timezone with `Asia/Kolkata` as the documented default and can change it from the private workspace.
- Seventeen stable category identifiers are seeded before transaction work; `Other` is the sole fallback.
- Telegram link and unlink challenges are high-entropy, stored only as SHA-256 digests, expire after ten minutes, are one-use, and share a five-per-user hourly issuance limit.
- Active Channel Identity ownership is unique. Unlinking retains history, and relinking never reassigns an active link.
- Effect HttpApi contracts expose private identity overview, timezone, and link/unlink challenge issuance endpoints with typed safe errors and `no-store` responses.
- Cookie-authenticated mutations fail closed unless their origin and Fetch Metadata are compatible with the configured first-party web origin.

## Automated evidence

- Domain tests validate the timezone brand/default and fixed category taxonomy.
- PostgreSQL migration tests validate migration ordering, seeded categories, defaults, constraints, and least-privilege grants.
- Identity-store integration tests cover concurrent first-session convergence, two-user isolation, timezone scope, link resolution, replay rejection, challenge expiry, rate limiting, ownership conflict, unlinking, and safe relinking.
- Workerd integration covers signup, session validation, User/Ledger provisioning, stable repeat resolution, private identity reads, timezone changes, link-challenge issuance, cross-site mutation rejection, and expired-session rejection.

Run `npm run check` and `npm run test:integration` from a migrated local PostgreSQL environment for the complete repository gate.

## Remaining evidence

- Apply migration `0007` and exercise the private identity surface in managed development and staging.
- Register and verify the Telegram webhook, then prove real provider delivery and challenge consumption through the channel adapter.
- Provision and prove recovery-email delivery before the combined authentication-policy checklist item can close.
