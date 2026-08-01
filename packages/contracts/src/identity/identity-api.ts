import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
} from "@effect/platform";
import { Context, Schema } from "effect";

import type { BetterAuthWebSession as BetterAuthWebSessionType } from "./better-auth-session.js";
import {
  ChangeIdentityTimezoneV1,
  CreateTelegramUnlinkChallengeV1,
  IdentityOverviewV1,
  TelegramChallengeV1,
} from "./identity.js";
import { CorrelationId } from "../platform/correlation-id.js";

const IdentityErrorBody = <Code extends Schema.Schema.Any>(code: Code) =>
  Schema.Struct({
    version: Schema.Literal(1),
    error: Schema.Struct({
      code,
      message: Schema.String,
      correlationId: CorrelationId,
    }),
  });

/** Stable unauthenticated response shared by all private Identity endpoints. */
export const IdentityUnauthorizedError = IdentityErrorBody(
  Schema.Literal("authentication_required"),
).annotations(HttpApiSchema.annotations({ status: 401 }));

/** A parsed unauthenticated Identity response. */
export type IdentityUnauthorizedError = typeof IdentityUnauthorizedError.Type;

/** Stable rejection for a cookie-authenticated mutation from an untrusted origin. */
export const IdentityForbiddenError = IdentityErrorBody(
  Schema.Literal("cross_site_request_forbidden"),
);

/** A parsed cross-site mutation rejection. */
export type IdentityForbiddenError = typeof IdentityForbiddenError.Type;

/** Stable validation response for client-owned Identity inputs. */
export const IdentityBadRequestError = IdentityErrorBody(
  Schema.Literal("invalid_timezone", "invalid_channel_identity"),
);

/** A parsed Identity validation response. */
export type IdentityBadRequestError = typeof IdentityBadRequestError.Type;

/** Stable response that does not distinguish absent from foreign link state. */
export const IdentityNotFoundError = IdentityErrorBody(
  Schema.Literal("channel_identity_not_found"),
);

/** A parsed private Identity not-found response. */
export type IdentityNotFoundError = typeof IdentityNotFoundError.Type;

/** Stable response when challenge issuance exceeds the per-user policy. */
export const IdentityRateLimitedError = Schema.Struct({
  version: Schema.Literal(1),
  error: Schema.Struct({
    code: Schema.Literal("challenge_rate_limited"),
    message: Schema.String,
    correlationId: CorrelationId,
    retryAfterSeconds: Schema.Int.pipe(Schema.positive()),
  }),
});

/** A parsed Identity rate-limit response. */
export type IdentityRateLimitedError = typeof IdentityRateLimitedError.Type;

/** Stable failure when authentication or Identity persistence is unavailable. */
export const IdentityUnavailableError = IdentityErrorBody(Schema.Literal("identity_unavailable"));

/** A parsed Identity availability response. */
export type IdentityUnavailableError = typeof IdentityUnavailableError.Type;

const IdentityAuthorizationError = Schema.Union(
  IdentityUnauthorizedError,
  IdentityForbiddenError.annotations(HttpApiSchema.annotations({ status: 403 })),
  IdentityUnavailableError.annotations(HttpApiSchema.annotations({ status: 503 })),
);

/** Request-local authenticated session and correlation data supplied by private middleware. */
export interface CurrentWebSessionService {
  readonly session: BetterAuthWebSessionType;
  readonly correlationId: CorrelationId;
}

/** Validated provider session supplied only by the private HTTP middleware. */
export class CurrentWebSession extends Context.Tag(
  "@xpensego/contracts/identity/CurrentWebSession",
)<CurrentWebSession, CurrentWebSessionService>() {}

/** Authorization middleware required by every private Identity endpoint. */
export class WebSessionAuthorization extends HttpApiMiddleware.Tag<WebSessionAuthorization>()(
  "@xpensego/contracts/identity/WebSessionAuthorization",
  {
    failure: IdentityAuthorizationError,
    provides: CurrentWebSession,
  },
) {}

/** Private Identity endpoints guarded by a verified Better Auth session. */
export const IdentityGroup = HttpApiGroup.make("identity")
  .add(
    HttpApiEndpoint.get("overview", "/identity")
      .addSuccess(IdentityOverviewV1)
      .addError(IdentityUnavailableError, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.put("changeTimezone", "/identity/timezone")
      .setPayload(ChangeIdentityTimezoneV1)
      .addSuccess(IdentityOverviewV1)
      .addError(IdentityBadRequestError, { status: 400 })
      .addError(IdentityUnavailableError, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.post("createTelegramLinkChallenge", "/identity/telegram/link-challenges")
      .addSuccess(TelegramChallengeV1, { status: 201 })
      .addError(IdentityRateLimitedError, { status: 429 })
      .addError(IdentityUnavailableError, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.post("createTelegramUnlinkChallenge", "/identity/telegram/unlink-challenges")
      .setPayload(CreateTelegramUnlinkChallengeV1)
      .addSuccess(TelegramChallengeV1, { status: 201 })
      .addError(IdentityBadRequestError, { status: 400 })
      .addError(IdentityNotFoundError, { status: 404 })
      .addError(IdentityRateLimitedError, { status: 429 })
      .addError(IdentityUnavailableError, { status: 503 }),
  )
  .middlewareEndpoints(WebSessionAuthorization);

/** Runtime API containing only private Identity routes and their middleware. */
export class IdentityApi extends HttpApi.make("xpensego-identity-api")
  .add(IdentityGroup)
  .prefix("/v1") {}
