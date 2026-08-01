# Workers-compatible authentication and API contracts

**Issue:** [#6](https://github.com/Vaibtan/XpensGo/issues/6)  
**Researched:** 2026-08-01  
**Status:** recommendation for the Phase 1 implementation spike; canonical decisions still belong in the Specification and an accepted ADR

## Decision summary

Adopt these two choices together:

1. **Self-host Better Auth in the API Worker, backed by the existing Neon PostgreSQL database through an invocation-scoped Hyperdrive `pg` pool.** Keep Xpensego's user, ledger ownership, Telegram identities, and one-use Telegram link challenges in application-owned tables and Effect services. Better Auth owns only web credentials, verification records, and sessions.
2. **Use `@effect/platform` `HttpApi` as the application API router and contract authority.** Define endpoints from Effect Schemas, generate OpenAPI 3.1 from that definition, and derive the web client from the same API value. Mount Better Auth's provider-owned handler under the versioned `/v1/auth/*` namespace and snapshot its separately generated OpenAPI document for upgrade review.

For development and the small controlled alpha, put transactional email behind an application adapter and use **Resend Free** for verification and recovery mail. Its current allowance is 3,000 messages per month and 100 per day, and it documents Cloudflare Workers directly. Cloudflare Email Sending is not a zero-cost arbitrary-recipient alternative: arbitrary recipients currently require Workers Paid, while free sends are limited to verified destination addresses. Re-evaluate the email provider before either alpha usage reaches 50% of the daily/monthly Resend allowance or the project selects Workers Paid. [Resend pricing](https://resend.com/pricing?product=transactional), [Resend Workers guide](https://resend.com/docs/send-with-cloudflare-workers), [Cloudflare Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/)

This selection minimizes new architectural seams: authentication remains an adapter that produces a verified principal, the Identity module remains authoritative for `ActorContext`, and HTTP contracts use the Effect Schema system already selected for every other boundary.

## Required shape

```text
Browser / OpenNext Worker
  -> same-origin /v1/* forwarding (Cloudflare Service Binding)
    -> API Worker
       /v1/auth/* -> Better Auth handler -> auth-only PostgreSQL tables
       /v1/*      -> Effect HttpApi -> Identity service -> ActorContext

Verified web principal (issuer, subject)
  -> application web identity
    -> stable Xpensego user id
      -> exactly one personal ledger

Authenticated web user
  -> Identity service creates hashed, expiring, one-use link challenge
    -> Telegram deep link
      -> verified Telegram webhook consumes challenge atomically
        -> application-owned channel identity -> same Xpensego user id
```

Cloudflare Service Bindings can forward an HTTP `Request` between Workers without a public API URL and do not add cost. For the controlled alpha, the OpenNext Worker should forward same-origin `/v1/*` requests to the API Worker so session cookies are first-party even on `workers.dev`. Production can retain that topology or use more-specific Cloudflare routes on the product domain. This avoids the third-party-cookie failure mode Better Auth documents for a frontend and auth API on different domains. [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/), [Cloudflare route precedence](https://developers.cloudflare.com/workers/configuration/routing/routes/), [Better Auth cookie deployment guidance](https://better-auth.com/docs/concepts/cookies)

### Effect and identity boundaries

- Better Auth responses, database records, error objects, and session types stay in an auth adapter. The domain sees an application-owned `VerifiedWebPrincipal` containing only an issuer, subject, authentication time/strength, and correlation ID.
- Map `(issuer, subject)` to a stable Xpensego user identifier. Do not use a provider user ID as the domain `UserId`; this is the main escape hatch for a later provider migration.
- The API Worker verifies the session, then the Identity service resolves the principal and ledger into `ActorContext`. Client payloads, Next.js code, Telegram messages, and model output never supply user or ledger scope.
- Telegram linking is **not** Better Auth social-account linking. It remains the Specification's application flow: a high-entropy challenge stored only as a hash, short expiry, rate limits, single atomic consumption, channel-identity uniqueness, and group-context rejection.
- Construct and close Better Auth's PostgreSQL pool within the Worker invocation. Do not retain it, its session state, or request state in module-global scope. A background task must not outlive that scoped pool; any deferred email work should contain only the already-committed token/link and provider request, not a live database client.
- Generate Better Auth SQL with its CLI, review it, and translate the accepted SQL into Xpensego's forward-only Effect SQL migration sequence. Never run Better Auth's automatic production migration from a request or Worker. Better Auth documents SQL generation for its built-in PostgreSQL/Kysely adapter. [Better Auth database and migration model](https://better-auth.com/docs/concepts/database), [Better Auth PostgreSQL adapter](https://better-auth.com/docs/adapters/postgresql)

### Authentication and recovery policy

The first release should support email/password only; social providers and MFA are additive work after the complete web-to-Telegram identity slice is proven.

- Require verified email before creating an application session.
- Return a generic response for signup/recovery attempts so account existence is not disclosed.
- Send a single-use password-reset link through the email adapter; configure a short expiry and revoke every existing session after a successful reset.
- Rate-limit signup, sign-in, verification, reset issuance, reset consumption, and Telegram link issuance/consumption by safe combinations of IP, account/email hash, and channel identity.
- Keep secure, HTTP-only, host-only, `SameSite=Lax` cookies on the same browser origin. Maintain explicit trusted origins and keep Better Auth's CSRF and origin checks enabled.
- Treat permanent deletion as a stronger application operation. Require explicit reauthentication and issue a separate short-lived, server-side deletion confirmation; session age alone is not sufficient proof of user intent.
- Persist content-minimized audit events for credential/recovery outcomes and destructive confirmation, never tokens, email contents, passwords, cookies, or raw provider errors.

Better Auth supplies database-backed sessions, freshness controls, session revocation, email verification, password reset hooks, origin checks, secure cookies, and built-in rate limiting. It intentionally requires a bring-your-own email provider. [Email verification and password reset](https://better-auth.com/docs/concepts/email), [session management](https://better-auth.com/docs/concepts/session-management), [security controls](https://better-auth.com/docs/reference/security), [rate limiting](https://better-auth.com/docs/concepts/rate-limit)

## Authentication option comparison

| Option                         | Fit                                                                                                                                                                             | Cost and ownership                                                                       | Main concern                                                                                                                                                                                                                                                                                      | Decision                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Self-hosted Better Auth + Neon | Better Auth documents a Cloudflare Worker handler, `nodejs_compat`, PostgreSQL, sessions, verification, reset, and standard `Request`/`Response` handling.                      | Library cost is zero; identity records live in Xpensego's PostgreSQL. Email is separate. | Xpensego owns upgrades, schema review, abuse controls, email delivery, and the Worker/Hyperdrive lifecycle.                                                                                                                                                                                       | **Select, subject to the spike gates below.**                                                                                       |
| Neon Auth                      | Managed Better Auth with users, sessions, configuration, and JWKS in a branchable `neon_auth` schema; currently included on Neon Free up to 60,000 MAU.                         | Operationally simple and identity data remains joinable in Neon.                         | Neon states it is not a drop-in self-hosted Better Auth replacement, requires Neon SDKs, and does not yet support custom server handlers/plugins. Current first-party material found in this run emphasizes Next.js/Vercel; no explicit OpenNext/Cloudflare Worker deployment contract was found. | **Do not enable now.** Revisit if Neon publishes and Xpensego proves the missing Worker, customization, export, and migration path. |
| Clerk                          | `@clerk/backend` explicitly supports V8 isolates/Cloudflare Workers; hosted UI and recovery reduce implementation work. Hobby currently includes 50,000 monthly retained users. | Fastest polished managed path. User export is documented.                                | Identity authority and session operations are external; application ownership requires sync/mapping, free sessions are fixed to seven days, and pricing is retained-user based after the free tier.                                                                                               | Viable fallback if delivery speed is later valued above database ownership.                                                         |
| WorkOS AuthKit                 | The JavaScript SDK documents Cloudflare Workers support and hosted password recovery. AuthKit is currently free up to 1 million MAU.                                            | Large free allowance and managed security/UX.                                            | Production requires billing information, custom domain is currently a paid add-on, identity lives outside Neon, and the product is oriented toward B2B/enterprise identity needs Xpensego does not have.                                                                                          | Reject for the initial consumer product.                                                                                            |
| Auth0 or Cloudflare Access     | Auth0 has broad CIAM capability; Access can protect a Worker with organization/IdP policies.                                                                                    | Managed operations.                                                                      | Auth0 adds an external identity authority and earlier paid thresholds; Cloudflare describes Access as Zero Trust access for organizations and internal/self-hosted resources, not consumer account ownership and recovery.                                                                        | Reject for this phase.                                                                                                              |

Sources: [Better Auth Cloudflare installation](https://better-auth.com/docs/installation), [Neon Auth architecture and limitations](https://neon.com/blog/neon-auth-branchable-identity-in-your-database), [Neon pricing](https://neon.com/pricing), [Clerk isolate support](https://clerk.com/docs/guides/development/sdk-development/backend-only), [Clerk pricing](https://clerk.com/pricing), [WorkOS Workers support](https://workos.com/changelog/cloudflare-workers-edge-support), [WorkOS environments and AuthKit pricing](https://workos.com/docs/authkit/environments), [WorkOS pricing](https://workos.com/pricing), [Cloudflare One identity-provider purpose](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/)

Pricing is point-in-time evidence, not an architectural guarantee. The release checklist must recheck it before external invitations.

## API routing and contract recommendation

Define a pure contract in `packages/contracts` using `HttpApi`, `HttpApiGroup`, `HttpApiEndpoint`, and the existing Effect Schemas. Add `@effect/platform` as a pinned direct dependency aligned exactly with the pinned `effect` version; do not rely on its current transitive installation.

For each endpoint, the contract must declare:

- method and `/v1` path;
- path/query/header/payload schemas with excess-field policy;
- every success representation;
- stable, safe typed error families and status codes;
- authentication middleware/security metadata;
- idempotency and cursor headers where applicable.

Implement groups with `HttpApiBuilder` so handlers return Effect values and depend on application-owned services. Use `HttpApiBuilder.toWebHandler` only in a way that creates one execution boundary for the `fetch` invocation and keeps bindings, `ActorContext`, database clients, correlation data, and scoped resources invocation-local. The implementation spike must reject any composition that caches a live database/auth Layer in module scope.

Generate and validate two contract artifacts in CI:

1. the application OpenAPI 3.1 document from `OpenApi.fromApi`;
2. the Better Auth OpenAPI document from `auth.api.generateOpenAPISchema()`.

The Better Auth OpenAPI plugin calls itself early-stage, so its schema is an upgrade-diff and documentation artifact, not Xpensego's application contract authority. Serve interactive reference UIs only in development or protected staging; production may expose the static JSON only if there is an explicit need. [Better Auth OpenAPI plugin](https://better-auth.com/docs/plugins/open-api)

Use `HttpApiClient.make` with the Fetch client in the OpenNext application, or export a small application-owned wrapper around the derived client. The domain must never import the HTTP client. The generated OpenAPI documents preserve an escape path for non-Effect clients and future tooling.

The pinned `@effect/platform@0.97.1` package installed in this repository exposes `HttpApiBuilder.toWebHandler(Request -> Promise<Response>)`, `OpenApi.fromApi` (OpenAPI 3.1), and `HttpApiClient.make`; all use the same `HttpApi`/Effect Schema definition. This claim was verified against the exact installed declaration/source files and the executable local proof below, not inferred from latest-main syntax. [Published `@effect/platform@0.97.1` registry record](https://registry.npmjs.org/@effect%2fplatform/0.97.1)

### Router option comparison

| Option                       | Strength                                                                                                                                     | Cost to this codebase                                                                                                                                           | Decision                                                                                                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@effect/platform` `HttpApi` | One Effect Schema defines runtime decoding, typed handlers/errors, OpenAPI, and a derived client; standard Web `Request`/`Response` handler. | Pre-1.0 package version requires exact pinning and deliberate upgrade tests; Worker resource composition needs a spike.                                         | **Select.** It deepens the existing Effect boundary instead of adding a parallel framework.                                                                                                                                                                      |
| Hono + `@hono/zod-openapi`   | Excellent Cloudflare support, mature middleware/routing, OpenAPI and RPC patterns.                                                           | Adds Hono plus Zod as a second schema/error system, or relies on a third-party bridge for Effect Schema; handlers still need an explicit Effect execution seam. | Keep as fallback if the Effect Worker spike fails a defined gate. [Hono Cloudflare guide](https://hono.dev/docs/getting-started/cloudflare-workers), [Hono OpenAPI example](https://hono.dev/examples/zod-openapi), [Hono RPC](https://hono.dev/docs/guides/rpc) |
| Hand-written Fetch routing   | Smallest dependency surface and already sufficient for the platform tracer.                                                                  | Path/query/middleware growth and OpenAPI/client drift would become application-owned framework work.                                                            | Retire after the tracer; retain only the top-level provider/application dispatch.                                                                                                                                                                                |

## Implementation and release gates

Selection is complete only after a disposable vertical spike proves all of the following with pinned versions:

### Authentication spike

- Better Auth bundles under the API Worker's actual compatibility date and flags, not only Node.js.
- Signup, verified-email sign-in, sign-out, session expiry/revocation, generic recovery request, reset, and all-session revocation pass in local Workerd and deployed staging.
- The Better Auth PostgreSQL pool is created from the invocation's Hyperdrive binding and closed after all required work; two concurrent users never share principal or session state.
- Generated Better Auth SQL is captured in a reviewed forward-only Effect migration; the runtime role cannot create/alter schema.
- The OpenNext Worker forwards `/v1/auth/*` and authenticated `/v1/*` through a Service Binding while preserving `Set-Cookie`, `Cookie`, `Origin`, `Host`, and correlation headers. Safari/mobile-width browser tests confirm no third-party-cookie dependency.
- CSRF/origin rejection, cookie flags, account enumeration, replay, brute-force limits, password-reset expiry, and secret redaction have automated evidence.
- Email sends are idempotent where provider support permits, tokens are never logged, and known/unknown delivery outcomes are observable without exposing addresses or links.

### API contract spike

- One representative authenticated endpoint decodes headers, path/query/payload, resolves `ActorContext`, returns a typed success/error, and runs through exactly one Worker execution boundary.
- `HttpApiBuilder.toWebHandler` bundles and runs in Workerd; no live Layer or request state is retained globally.
- OpenAPI generation is deterministic, checked into or published from a defined path, and CI fails on unreviewed drift.
- The OpenNext server-side client calls the API Worker over a Service Binding and a browser call uses the same contract without shared caching.
- Unknown request fields, unknown routes, unauthenticated requests, foreign resources, malformed cursors, and duplicate idempotency keys have contract tests.

If the Better Auth Worker/Hyperdrive spike fails, move to Clerk rather than inventing authentication. If `HttpApi` fails Workerd compatibility, bundling, or invocation-scope gates, move to Hono while keeping Effect Schemas in `packages/contracts` and executing exactly one Effect program per request.

## Evidence and limits

This research used current first-party documentation and source on 2026-08-01, plus the repository's pinned dependency installation. It did **not** provision or mutate an auth provider, send email, alter Neon, or deploy a new Worker. Absence of an explicit Neon Auth Cloudflare/OpenNext guide in the reviewed first-party material is a compatibility evidence gap, not proof that Neon Auth cannot work.

Local validation executed against the repository's installed `effect@3.22.1` and transitive `@effect/platform@0.97.1`:

- constructed an `HttpApi` status endpoint from an Effect Schema;
- implemented it with `HttpApiBuilder.group`;
- converted it to a standard Web handler with `HttpApiBuilder.toWebHandler`;
- called it with a native `Request` and received status `200` plus the decoded JSON body;
- generated OpenAPI `3.1.0` with the expected `/v1/platform/status` path;
- disposed the handler runtime.

That was a Node Web-API proof, not Workerd or deployed Cloudflare evidence. The implementation gates above remain blocking.

Context7 was run for Better Auth, Effect Platform, and Hono before first-party source review, as required by the repository instructions. The Effect result reflected the latest upstream documentation, so pinned `@effect/platform@0.97.1` exports were also inspected locally rather than assuming current-main syntax applies unchanged.

### Exact research and validation record

Context7 commands executed (library resolution preceded documentation retrieval in each case):

```powershell
npx ctx7@latest library "Better Auth" "Which Workers-compatible authentication and account-recovery approach best satisfies Cloudflare Workers/OpenNext, Effect service boundaries, Telegram one-use account linking, zero-cost development/small alpha, pricing upgrade triggers, and migration or lock-in concerns?"
npx ctx7@latest docs /better-auth/better-auth "Which Workers-compatible authentication and account-recovery approach best satisfies Cloudflare Workers/OpenNext, Effect service boundaries, Telegram one-use account linking, zero-cost development/small alpha, pricing upgrade triggers, and migration or lock-in concerns? Focus on Cloudflare Workers, PostgreSQL, email verification, password reset/recovery, sessions/cookies, Next.js handlers, schema/migrations, trusted origins, CSRF, account linking, and portability."

npx ctx7@latest library "Effect Platform" "Which API routing and OpenAPI/contract-generation stack best satisfies Cloudflare Workers/OpenNext, Effect service boundaries, runtime Effect Schema contracts, generated OpenAPI, Workers compatibility, zero-cost development/small alpha, and migration or lock-in concerns?"
npx ctx7@latest docs /effect-ts/effect "Which API routing and OpenAPI/contract-generation stack best satisfies Cloudflare Workers/OpenNext, Effect service boundaries, runtime Effect Schema contracts, generated OpenAPI, Workers compatibility, zero-cost development/small alpha, and migration or lock-in concerns? Focus on @effect/platform HttpApi, HttpApiBuilder, HttpApiEndpoint, OpenApi.fromApi or middleware, generated clients, FetchHttpClient, and Cloudflare Workers handlers/adapters."

npx ctx7@latest library "Hono" "Compare Hono routing and OpenAPI contract generation with Effect Platform HttpApi for a Cloudflare Workers API that uses Effect Schema at runtime, generated OpenAPI and typed clients, OpenNext, zero-cost development/small alpha, and low migration or lock-in risk."
npx ctx7@latest docs /websites/hono_dev "Compare Hono routing and OpenAPI contract generation with Effect Platform HttpApi for a Cloudflare Workers API that uses Effect Schema at runtime, generated OpenAPI and typed clients, OpenNext, zero-cost development/small alpha, and low migration or lock-in risk. Focus on Cloudflare Workers support, routing, validation, RPC clients, OpenAPI support, middleware, and interoperability with standard Request/Response."
```

The disposable API proof was executed from the repository root with `node --input-type=module`. It built an Effect Schema status contract, an `HttpApi`/`HttpApiBuilder.group` implementation, and a `HttpApiBuilder.toWebHandler`; invoked that handler with `new Request("https://api.example.test/v1/platform/status")`; generated `OpenApi.fromApi(api)`; and disposed the runtime. Exact result:

```json
{
  "status": 200,
  "body": { "version": 1, "ok": true },
  "openapi": "3.1.0",
  "paths": ["/v1/platform/status"]
}
```

Additional verification performed:

- `npm ls @effect/platform @effect/platform-node --all` confirmed the installed pair `effect@3.22.1` / `@effect/platform@0.97.1`; the exact installed `HttpApi`, `HttpApiBuilder`, `HttpApiClient`, `OpenApi`, and package declaration/source files were inspected.
- `gh issue view 6 --repo Vaibtan/XpensGo --json number,state,title,url` confirmed the research issue and its open status.
- `npm exec prettier -- --check docs/research/workers-auth-api-contracts.md` passed after formatting.
- A native Node `fetch` check followed redirects for every unique public source URL in this note: 26 checked, zero failed. The private-repository issue URL was excluded from anonymous HTTP checking and verified through `gh` instead.
- `git status --short` confirmed this work added only `docs/research/`; the pre-existing `.gitignore`, `.agents/`, and `.playwright-mcp/` changes were not touched.
