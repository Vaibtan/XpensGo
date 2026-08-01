import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform";
import { Schema } from "effect";

import { IdentityGroup } from "../identity/identity-api.js";
import { CorrelationId } from "./correlation-id.js";
import { PlatformStatusV1 } from "./platform-status.js";

/** Stable bad-request payload returned by platform endpoints. */
export const PlatformBadRequestError = Schema.Struct({
  version: Schema.Literal(1),
  error: Schema.Struct({
    code: Schema.Literal("invalid_correlation_id"),
    message: Schema.String,
    correlationId: CorrelationId,
  }),
});

/** A parsed versioned platform bad-request response. */
export type PlatformBadRequestError = typeof PlatformBadRequestError.Type;

/** Stable internal-error payload declared by application endpoint contracts. */
export const PlatformInternalError = Schema.Struct({
  version: Schema.Literal(1),
  error: Schema.Struct({
    code: Schema.Literal("internal_error"),
    message: Schema.String,
    correlationId: CorrelationId,
  }),
});

/** A parsed versioned platform internal-error response. */
export type PlatformInternalError = typeof PlatformInternalError.Type;

/** Stable response for a path outside the versioned application route set. */
export const PlatformRouteNotFoundError = Schema.Struct({
  version: Schema.Literal(1),
  error: Schema.Struct({
    code: Schema.Literal("route_not_found"),
    message: Schema.String,
    correlationId: CorrelationId,
  }),
});

/** A parsed versioned platform route-not-found response. */
export type PlatformRouteNotFoundError = typeof PlatformRouteNotFoundError.Type;

const PlatformStatusHeaders = Schema.Struct({
  "x-correlation-id": Schema.optional(Schema.String),
});

const PlatformGroup = HttpApiGroup.make("platform").add(
  HttpApiEndpoint.get("status", "/platform/status")
    .setHeaders(PlatformStatusHeaders)
    .addSuccess(PlatformStatusV1)
    .addError(PlatformBadRequestError, { status: 400 })
    .addError(PlatformInternalError, { status: 500 }),
);

/** Runtime API containing database-free platform routes. */
export class PlatformApi extends HttpApi.make("xpensego-platform-api")
  .add(PlatformGroup)
  .prefix("/v1") {}

/** Versioned Xpensego application API contract. */
export class XpensegoApi extends HttpApi.make("xpensego-api")
  .add(PlatformGroup)
  .add(IdentityGroup)
  .prefix("/v1") {}

/** OpenAPI 3.1 document generated from the runtime application contract. */
export const XpensegoOpenApi = OpenApi.fromApi(XpensegoApi);
