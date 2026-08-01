---
status: accepted
date: 2026-08-01
---

# Use self-hosted Better Auth and Effect HttpApi

Xpensego will self-host Better Auth in the API Worker against Neon PostgreSQL through an invocation-scoped Hyperdrive connection. Better Auth owns web credentials, verification records, and sessions; application-owned Identity services map the verified web principal to the stable Xpensego User, Ledger, ActorContext, and Telegram Channel Identity. Verification and recovery email is sent through an application adapter, using Resend during development and the small alpha.

Versioned application endpoints use pinned `@effect/platform` `HttpApi` definitions built from Effect Schemas. The same definition owns runtime decoding, typed handlers and errors, OpenAPI generation, and the derived web client. Better Auth remains isolated under `/v1/auth/*`; its provider contract does not become the application API authority.

## Considered options

- Managed Neon Auth or an external identity provider such as Clerk, WorkOS, or Auth0.
- Hono or hand-written Fetch routing with a parallel schema/OpenAPI system.
- Self-hosted Better Auth plus Effect HttpApi.

The selected option keeps identity relationships and financial authorization inside Xpensego's database and Effect boundary without adding a second routing or schema framework. Neon Auth did not yet have the required custom-handler and explicit Cloudflare/OpenNext evidence, while external identity providers would make sessions and recovery an additional remote authority.

## Consequences

- Neon Auth remains disabled. No alternative authentication provider or HTTP framework is installed or maintained as a fallback.
- If either selected stack fails its required Workerd, Hyperdrive, cookie, resource-lifecycle, or contract-generation spike, implementation stops and this decision is reopened.
- Better Auth SQL is reviewed and translated into Xpensego's forward-only Effect migrations; request handling never runs automatic production migrations.
- Authentication produces a verified principal only. Clients and provider records cannot construct an ActorContext or select a User or Ledger.
- Telegram linking remains an application-owned, hashed, expiring, rate-limited, one-use challenge flow rather than Better Auth account linking.
- The OpenNext Worker forwards same-origin `/v1/*` traffic to the API Worker through a Service Binding so secure host cookies and origin checks do not depend on third-party cookies.
- Resend is hidden behind an email service interface and its allowance is rechecked before external invitations; it is not a domain dependency.
