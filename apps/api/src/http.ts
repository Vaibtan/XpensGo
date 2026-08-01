import {
  HttpApp,
  HttpApiBuilder,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import {
  PlatformBadRequestError,
  PlatformRouteNotFoundError,
  XpensegoApi,
  XpensegoOpenApi,
} from "@xpensego/contracts/platform/platform-api";
import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { readPlatformStatus } from "@xpensego/domain/platform/read-platform-status";
import type { RuntimeConfig } from "@xpensego/domain/platform/runtime-config";
import type { RuntimeTelemetry } from "@xpensego/domain/platform/runtime-telemetry";
import { Effect, Layer, Schema } from "effect";

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

const PlatformHandlers = HttpApiBuilder.group(XpensegoApi, "platform", (handlers) =>
  handlers.handle("status", ({ headers }) => {
    const fallback = generatedCorrelationId();
    const candidate = headers["x-correlation-id"] ?? fallback;

    return Schema.decodeUnknown(CorrelationId)(candidate).pipe(
      Effect.mapError(() => invalidCorrelationId(fallback)),
      Effect.flatMap((correlationId) => readPlatformStatus({ correlationId })),
    );
  }),
);

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

function applicationApiLayer(
  invocationLayer: Layer.Layer<RuntimeConfig | RuntimeTelemetry, unknown>,
) {
  const handlers = PlatformHandlers.pipe(Layer.provide(invocationLayer));
  const api = HttpApiBuilder.api(XpensegoApi).pipe(Layer.provide(handlers));

  return Layer.mergeAll(api, OpenApiRoute, NotFoundRoute, HttpServer.layerContext);
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
  const { dispose, handler } = HttpApiBuilder.toWebHandler(applicationApiLayer(invocationLayer), {
    middleware: noStore,
  });

  return handler(request).finally(dispose);
}
