import {
  HttpApp,
  HttpApiBuilder,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import {
  type BetterAuthRuntimeConfig,
  resolveBetterAuthWebSession,
} from "@xpensego/adapters/auth/better-auth";
import {
  CurrentWebSession,
  type CurrentWebSessionService,
  type IdentityBadRequestError,
  type IdentityForbiddenError,
  type IdentityNotFoundError,
  type IdentityRateLimitedError,
  type IdentityUnauthorizedError,
  type IdentityUnavailableError,
  IdentityApi,
  WebSessionAuthorization,
} from "@xpensego/contracts/identity/identity-api";
import type {
  IdentityOverviewV1,
  TelegramChallengeV1,
} from "@xpensego/contracts/identity/identity";
import {
  PlatformBadRequestError,
  PlatformApi,
  PlatformRouteNotFoundError,
  XpensegoOpenApi,
} from "@xpensego/contracts/platform/platform-api";
import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { AuthUserId } from "@xpensego/domain/identity/actor-context";
import { ChannelIdentityId } from "@xpensego/domain/identity/channel-identity";
import {
  ChannelIdentityNotFound,
  ChannelLinkChallengeRateLimited,
  IdentityAuthorityNotFound,
  type IdentityOverview,
  type IdentityStore,
  type LinkChallengeCrypto,
  changeUserTimezone,
  createTelegramLinkChallenge,
  createTelegramUnlinkChallenge,
  readIdentityOverview,
  resolveWebActor,
} from "@xpensego/domain/identity/identity";
import { UserTimezone } from "@xpensego/domain/identity/user-timezone";
import { readPlatformStatus } from "@xpensego/domain/platform/read-platform-status";
import type { RuntimeConfig } from "@xpensego/domain/platform/runtime-config";
import type { RuntimeTelemetry } from "@xpensego/domain/platform/runtime-telemetry";
import { Effect, Layer, Redacted, Schema } from "effect";

function generatedCorrelationId(): CorrelationId {
  return Schema.decodeUnknownSync(CorrelationId)(crypto.randomUUID());
}

function invalidCorrelationId(correlationId: CorrelationId): PlatformBadRequestError {
  return {
    version: 1,
    error: {
      code: "invalid_correlation_id",
      message: "The correlation identifier is invalid.",
      correlationId,
    },
  };
}

function identityUnavailable(correlationId: CorrelationId): IdentityUnavailableError {
  return {
    version: 1,
    error: {
      code: "identity_unavailable",
      message: "Identity services are temporarily unavailable.",
      correlationId,
    },
  };
}

function identityNotFound(correlationId: CorrelationId): IdentityNotFoundError {
  return {
    version: 1,
    error: {
      code: "channel_identity_not_found",
      message: "The Telegram identity is not available.",
      correlationId,
    },
  };
}

function crossSiteRequestForbidden(correlationId: CorrelationId): IdentityForbiddenError {
  return {
    version: 1,
    error: {
      code: "cross_site_request_forbidden",
      message: "The request origin is not allowed.",
      correlationId,
    },
  };
}

function identityBadRequest(
  correlationId: CorrelationId,
  code: IdentityBadRequestError["error"]["code"],
  message: string,
): IdentityBadRequestError {
  return { version: 1, error: { code, message, correlationId } };
}

function identityRateLimited(
  correlationId: CorrelationId,
  error: ChannelLinkChallengeRateLimited,
): IdentityRateLimitedError {
  return {
    version: 1,
    error: {
      code: "challenge_rate_limited",
      message: "Too many Telegram verification challenges were requested.",
      correlationId,
      retryAfterSeconds: error.retryAfterSeconds,
    },
  };
}

function toIdentityOverview(
  session: CurrentWebSessionService["session"],
  overview: IdentityOverview,
): IdentityOverviewV1 {
  return {
    version: 1,
    user: {
      id: overview.actor.userId,
      email: session.user.email,
      name: session.user.name,
      timezone: overview.actor.timezone,
    },
    ledger: { id: overview.actor.ledgerId },
    telegramIdentities: overview.telegramIdentities,
  };
}

const resolveCurrentIdentity = Effect.fn("Api.resolveCurrentIdentity")(function* () {
  const current = yield* CurrentWebSession;
  const authUserId = yield* Schema.decodeUnknown(AuthUserId)(current.session.user.id).pipe(
    Effect.mapError(() => identityUnavailable(current.correlationId)),
  );
  const actor = yield* resolveWebActor({
    authUserId,
    correlationId: current.correlationId,
  }).pipe(Effect.mapError(() => identityUnavailable(current.correlationId)));
  return { actor, current };
});

const PlatformHandlers = HttpApiBuilder.group(PlatformApi, "platform", (handlers) =>
  handlers.handle("status", ({ headers }) => {
    const fallback = generatedCorrelationId();
    const candidate = headers["x-correlation-id"] ?? fallback;

    return Schema.decodeUnknown(CorrelationId)(candidate).pipe(
      Effect.mapError(() => invalidCorrelationId(fallback)),
      Effect.flatMap((correlationId) => readPlatformStatus({ correlationId })),
    );
  }),
);

const IdentityHandlers = HttpApiBuilder.group(IdentityApi, "identity", (handlers) =>
  handlers
    .handle("overview", () =>
      Effect.gen(function* () {
        const { actor, current } = yield* resolveCurrentIdentity();
        const overview = yield* readIdentityOverview({ actor }).pipe(
          Effect.mapError(() => identityUnavailable(current.correlationId)),
        );
        return toIdentityOverview(current.session, overview);
      }),
    )
    .handle("changeTimezone", ({ payload }) =>
      Effect.gen(function* () {
        const { actor, current } = yield* resolveCurrentIdentity();
        const timezone = yield* Schema.decodeUnknown(UserTimezone)(payload.timezone).pipe(
          Effect.mapError(() =>
            identityBadRequest(
              current.correlationId,
              "invalid_timezone",
              "Provide a supported IANA timezone.",
            ),
          ),
        );
        const changedActor = yield* changeUserTimezone({ actor, timezone }).pipe(
          Effect.mapError(() => identityUnavailable(current.correlationId)),
        );
        const overview = yield* readIdentityOverview({ actor: changedActor }).pipe(
          Effect.mapError(() => identityUnavailable(current.correlationId)),
        );
        return toIdentityOverview(current.session, overview);
      }),
    )
    .handle("createTelegramLinkChallenge", () =>
      Effect.gen(function* () {
        const { actor, current } = yield* resolveCurrentIdentity();
        const challenge = yield* createTelegramLinkChallenge({ actor }).pipe(
          Effect.mapError((error) =>
            error instanceof ChannelLinkChallengeRateLimited
              ? identityRateLimited(current.correlationId, error)
              : identityUnavailable(current.correlationId),
          ),
        );
        return {
          version: 1,
          channel: "telegram",
          purpose: "link",
          token: Redacted.value(challenge.token),
          expiresAtMillis: challenge.expiresAtMillis,
        } satisfies TelegramChallengeV1;
      }),
    )
    .handle("createTelegramUnlinkChallenge", ({ payload }) =>
      Effect.gen(function* () {
        const { actor, current } = yield* resolveCurrentIdentity();
        const channelIdentityId = yield* Schema.decodeUnknown(ChannelIdentityId)(
          payload.channelIdentityId,
        ).pipe(
          Effect.mapError(() =>
            identityBadRequest(
              current.correlationId,
              "invalid_channel_identity",
              "The Telegram identity identifier is invalid.",
            ),
          ),
        );
        const challenge = yield* createTelegramUnlinkChallenge({
          actor,
          channelIdentityId,
        }).pipe(
          Effect.mapError((error) => {
            if (error instanceof ChannelLinkChallengeRateLimited) {
              return identityRateLimited(current.correlationId, error);
            }
            if (
              error instanceof ChannelIdentityNotFound ||
              error instanceof IdentityAuthorityNotFound
            ) {
              return identityNotFound(current.correlationId);
            }
            return identityUnavailable(current.correlationId);
          }),
        );
        return {
          version: 1,
          channel: "telegram",
          purpose: "unlink",
          token: Redacted.value(challenge.token),
          expiresAtMillis: challenge.expiresAtMillis,
        } satisfies TelegramChallengeV1;
      }),
    ),
);

function webSessionAuthorizationLayer(config: BetterAuthRuntimeConfig) {
  const authorization = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const fallback = generatedCorrelationId();
    const correlationId = yield* Schema.decodeUnknown(CorrelationId)(
      request.headers["x-correlation-id"] ?? fallback,
    ).pipe(Effect.orElseSucceed(() => fallback));
    const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
    const fetchSite = request.headers["sec-fetch-site"];
    if (
      isMutation &&
      (request.headers.origin !== config.trustedOrigin ||
        (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none"))
    ) {
      return yield* Effect.fail<IdentityForbiddenError>(crossSiteRequestForbidden(correlationId));
    }
    const session = yield* resolveBetterAuthWebSession(config, new Headers(request.headers)).pipe(
      Effect.mapError(() => identityUnavailable(correlationId)),
    );
    if (session === null) {
      return yield* Effect.fail<IdentityUnauthorizedError>({
        version: 1,
        error: {
          code: "authentication_required",
          message: "Sign in to access this resource.",
          correlationId,
        },
      });
    }
    return { session, correlationId };
  });

  return Layer.succeed(WebSessionAuthorization, authorization);
}

const OpenApiRoute = HttpApiBuilder.Router.use((router) =>
  router.get(
    "/v1/openapi.json",
    HttpServerResponse.json(XpensegoOpenApi, {
      headers: {
        "cache-control": "no-store",
      },
    }).pipe(Effect.orDie),
  ),
);

const NotFoundRoute = HttpApiBuilder.Router.use((router) =>
  router.all(
    "*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const fallback = generatedCorrelationId();
      const correlationId = yield* Schema.decodeUnknown(CorrelationId)(
        request.headers["x-correlation-id"] ?? fallback,
      ).pipe(Effect.orElseSucceed(() => fallback));

      const responseBody: PlatformRouteNotFoundError = {
        version: 1,
        error: {
          code: "route_not_found",
          message: "The requested route does not exist.",
          correlationId,
        },
      };

      return yield* HttpServerResponse.json(responseBody, { status: 404 });
    }).pipe(Effect.orDie),
  ),
);

function noStore(httpApp: HttpApp.Default): HttpApp.Default {
  return HttpApp.withPreResponseHandler(httpApp, (_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
  );
}

function platformApiLayer(invocationLayer: Layer.Layer<RuntimeConfig | RuntimeTelemetry, unknown>) {
  const handlers = PlatformHandlers.pipe(Layer.provide(invocationLayer));
  const api = HttpApiBuilder.api(PlatformApi).pipe(Layer.provide(handlers));

  return Layer.mergeAll(api, OpenApiRoute, NotFoundRoute, HttpServer.layerContext);
}

function identityApiLayer(
  invocationLayer: Layer.Layer<IdentityStore | LinkChallengeCrypto, unknown>,
  betterAuthConfig: BetterAuthRuntimeConfig,
) {
  const handlers = IdentityHandlers.pipe(Layer.provide(invocationLayer));
  const api = HttpApiBuilder.api(IdentityApi).pipe(
    Layer.provide(handlers),
    Layer.provide(webSessionAuthorizationLayer(betterAuthConfig)),
  );

  return Layer.mergeAll(api, NotFoundRoute, HttpServer.layerContext);
}

/**
 * Execute one application HTTP request through the versioned Effect HttpApi contract.
 *
 * @param request - Standard Web request supplied by the Cloudflare Worker.
 * @param invocationLayer - Request-scoped validated configuration and telemetry.
 * @returns The encoded HTTP response.
 */
export function handleApplicationRequest(
  request: Request,
  invocationLayer: Layer.Layer<RuntimeConfig | RuntimeTelemetry, unknown>,
): Promise<Response> {
  const { dispose, handler } = HttpApiBuilder.toWebHandler(platformApiLayer(invocationLayer), {
    middleware: noStore,
  });

  return handler(request).finally(dispose);
}

/** Execute one private Identity request without acquiring resources for unrelated routes. */
export function handleIdentityRequest(
  request: Request,
  invocationLayer: Layer.Layer<IdentityStore | LinkChallengeCrypto, unknown>,
  betterAuthConfig: BetterAuthRuntimeConfig,
): Promise<Response> {
  const { dispose, handler } = HttpApiBuilder.toWebHandler(
    identityApiLayer(invocationLayer, betterAuthConfig),
    { middleware: noStore },
  );

  return handler(request).finally(dispose);
}
