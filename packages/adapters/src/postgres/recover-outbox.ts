import { NodeRuntime } from "@effect/platform-node";
import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import { recoverFailedOutboxPublication } from "@xpensego/domain/outbox/outbox-delivery";
import { Effect, Schema } from "effect";

import { resolveMigrationDatabaseUrl } from "./migration-database-url.js";
import { makePostgresOutboxRecoveryLayer } from "./outbox-store.js";

class OutboxRecoveryCommandFailed extends Schema.TaggedError<OutboxRecoveryCommandFailed>()(
  "OutboxRecoveryCommandFailed",
  {
    reason: Schema.Literal("invalid_identifier", "not_recoverable", "persistence_unavailable"),
  },
) {
  override get message(): string {
    return `Outbox recovery failed: ${this.reason}.`;
  }
}

const program = Effect.gen(function* () {
  const outboxMessageId = yield* Schema.decodeUnknown(OutboxMessageId)(process.argv[2]).pipe(
    Effect.mapError(() => new OutboxRecoveryCommandFailed({ reason: "invalid_identifier" })),
  );
  const recovered = yield* recoverFailedOutboxPublication({ outboxMessageId }).pipe(
    Effect.mapError(() => new OutboxRecoveryCommandFailed({ reason: "persistence_unavailable" })),
  );

  if (!recovered) {
    return yield* new OutboxRecoveryCommandFailed({ reason: "not_recoverable" });
  }

  yield* Effect.logInfo("Terminal outbox publication returned to the dispatcher", {
    outboxMessageId,
  });
}).pipe(Effect.provide(makePostgresOutboxRecoveryLayer(resolveMigrationDatabaseUrl())));

NodeRuntime.runMain(program);
