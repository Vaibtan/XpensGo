import { betterAuth } from "better-auth";
import { Effect, Redacted, Schema } from "effect";
import { Pool } from "pg";

/** Validated inputs needed to construct the sole Better Auth adapter. */
export interface BetterAuthRuntimeConfig {
  readonly baseUrl: string;
  readonly databaseUrl: Redacted.Redacted<string>;
  readonly secret: Redacted.Redacted<string>;
  readonly trustedOrigin: string;
  readonly useSecureCookies: boolean;
}

/** Safe startup rejection for an invalid Better Auth runtime configuration. */
export class InvalidBetterAuthConfig extends Schema.TaggedError<InvalidBetterAuthConfig>()(
  "InvalidBetterAuthConfig",
  {
    field: Schema.Literal("baseUrl", "databaseUrl", "secret", "trustedOrigin"),
  },
) {
  override get message(): string {
    return `Authentication configuration field ${this.field} is invalid.`;
  }
}

/** Safe failure at the selected authentication provider boundary. */
export class BetterAuthUnavailable extends Schema.TaggedError<BetterAuthUnavailable>()(
  "BetterAuthUnavailable",
  {
    operation: Schema.Literal("handleAuthRequest"),
    reason: Schema.Literal("provider_unavailable"),
  },
) {
  override get message(): string {
    return "Authentication is temporarily unavailable.";
  }
}

function validHttpOrigin(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      parsed.origin === candidate &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
}

function validateConfig(config: BetterAuthRuntimeConfig) {
  return Effect.gen(function* () {
    if (!validHttpOrigin(config.baseUrl)) {
      return yield* new InvalidBetterAuthConfig({ field: "baseUrl" });
    }
    if (!validHttpOrigin(config.trustedOrigin)) {
      return yield* new InvalidBetterAuthConfig({ field: "trustedOrigin" });
    }
    if (Redacted.value(config.secret).length < 32) {
      return yield* new InvalidBetterAuthConfig({ field: "secret" });
    }
    try {
      const parsed = new URL(Redacted.value(config.databaseUrl));
      if (!["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.hostname.length === 0) {
        return yield* new InvalidBetterAuthConfig({ field: "databaseUrl" });
      }
    } catch {
      return yield* new InvalidBetterAuthConfig({ field: "databaseUrl" });
    }
    return config;
  });
}

/** Handle one provider-owned auth request with an invocation-scoped PostgreSQL pool. */
export function handleBetterAuthRequest(config: BetterAuthRuntimeConfig, request: Request) {
  return Effect.gen(function* () {
    const validated = yield* validateConfig(config);
    const pool = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Pool({
            connectionString: Redacted.value(validated.databaseUrl),
            connectionTimeoutMillis: 5_000,
            idleTimeoutMillis: 1_000,
            max: 1,
          }),
      ),
      (resource) => Effect.tryPromise(() => resource.end()).pipe(Effect.orDie),
    );
    const auth = betterAuth({
      appName: "Xpensego",
      basePath: "/v1/auth",
      baseURL: validated.baseUrl,
      database: pool,
      secret: Redacted.value(validated.secret),
      trustedOrigins: [validated.trustedOrigin],
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: false,
      },
      advanced: {
        database: { generateId: "uuid" },
        disableCSRFCheck: false,
        disableOriginCheck: false,
        ipAddress: {
          ipAddressHeaders: ["cf-connecting-ip"],
        },
        useSecureCookies: validated.useSecureCookies,
      },
      rateLimit: {
        enabled: true,
        max: 20,
        storage: "database",
        window: 60,
      },
      user: { modelName: "auth_user" },
      session: { modelName: "auth_session" },
      account: { modelName: "auth_account" },
      verification: { modelName: "auth_verification" },
    });

    return yield* Effect.tryPromise({
      try: () => auth.handler(request),
      catch: () =>
        new BetterAuthUnavailable({
          operation: "handleAuthRequest",
          reason: "provider_unavailable",
        }),
    }).pipe(
      Effect.tapError(() =>
        Effect.logWarning("Better Auth request failed", {
          operation: "handleAuthRequest",
        }),
      ),
    );
  }).pipe(Effect.scoped);
}
