import { PgClient } from "@effect/sql-pg";
import { OutboxPersistenceUnavailable } from "@xpensego/domain/outbox/outbox-delivery";
import { Effect, Layer, type Redacted } from "effect";

import { layerWithoutDependencies as deliveryLayer } from "./telegram-delivery-store.js";
import { layerWithoutDependencies as processingLayer } from "./telegram-event-processing-store.js";
import { layerWithoutDependencies as identityLayer } from "./identity-store.js";
import { layerWithoutDependencies as outboxLayer } from "./outbox-store.js";

/**
 * Share one invocation-scoped PostgreSQL client across Queue consumer authorities.
 *
 * A connection failure is exposed through the established outbox retry family before any
 * event or provider-attempt claim can be created.
 */
export function makePostgresTelegramQueueRuntimeLayer(databaseUrl: Redacted.Redacted<string>) {
  const clientLayer = PgClient.layer({
    url: databaseUrl,
    applicationName: "xpensego-telegram-queue",
    connectTimeout: "5 seconds",
    idleTimeout: "1 second",
    maxConnections: 5,
  }).pipe(
    Layer.tapError((cause) =>
      Effect.logWarning("PostgreSQL Telegram Queue connection failed", {
        causeTag: cause instanceof Error ? cause.name : "UnknownFailure",
      }),
    ),
    Layer.mapError(
      () =>
        new OutboxPersistenceUnavailable({
          operation: "connectOutboxPersistence",
          reason: "database_unavailable",
        }),
    ),
  );

  return Layer.mergeAll(outboxLayer, identityLayer, processingLayer, deliveryLayer).pipe(
    Layer.provide(clientLayer),
  );
}
