import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import {
  CloudflareAccountId,
  CloudflareQueueId,
  makeCloudflareQueueApiPublicationLayer,
} from "@xpensego/adapters/cloudflare/queue-api-publication";
import { resolveMigrationDatabaseUrl } from "@xpensego/adapters/postgres/migration-database-url";
import { makePostgresTelegramDeliveryRecoveryStoreLayer } from "@xpensego/adapters/postgres/telegram-delivery-recovery-store";
import { OutboundChannelMessageId } from "@xpensego/domain/channel/outbound-channel-intent";
import {
  TelegramDeliveryRecoveryExpectedErrorCode,
  TelegramDeliveryRecoveryId,
  TelegramDeliveryRecoveryReason,
  recoverTelegramDelivery,
} from "@xpensego/domain/channel/recover-telegram-delivery";
import { Effect, Layer, Redacted, Schema } from "effect";

const QueueApiToken = Schema.String.pipe(Schema.minLength(20), Schema.maxLength(512));
const OperatorEnvironment = Schema.Struct({
  accountId: CloudflareAccountId,
  queueId: CloudflareQueueId,
  apiToken: QueueApiToken,
  recoveryId: TelegramDeliveryRecoveryId,
  outboundMessageId: OutboundChannelMessageId,
  expectedErrorCode: TelegramDeliveryRecoveryExpectedErrorCode,
  reason: TelegramDeliveryRecoveryReason,
  confirmation: Schema.Literal("recover"),
});

class TelegramDeliveryRecoveryCommandFailed extends Schema.TaggedError<TelegramDeliveryRecoveryCommandFailed>()(
  "TelegramDeliveryRecoveryCommandFailed",
  {
    reason: Schema.Literal(
      "invalid_configuration",
      "not_recoverable",
      "persistence_unavailable",
      "queue_unavailable",
      "queue_outcome_unknown",
      "state_conflict",
    ),
  },
) {
  override get message(): string {
    return `Telegram delivery recovery failed: ${this.reason}.`;
  }
}

const program = Effect.gen(function* () {
  const databaseUrl = yield* resolveMigrationDatabaseUrl().pipe(
    Effect.mapError(
      () => new TelegramDeliveryRecoveryCommandFailed({ reason: "invalid_configuration" }),
    ),
  );
  const environment = yield* Schema.decodeUnknown(OperatorEnvironment)({
    accountId: process.env.XPENSEGO_CLOUDFLARE_ACCOUNT_ID,
    queueId: process.env.XPENSEGO_CLOUDFLARE_QUEUE_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    recoveryId: process.env.XPENSEGO_TELEGRAM_RECOVERY_ID,
    outboundMessageId: process.env.XPENSEGO_TELEGRAM_OUTBOUND_MESSAGE_ID,
    expectedErrorCode: process.env.XPENSEGO_TELEGRAM_EXPECTED_ERROR_CODE,
    reason: process.env.XPENSEGO_TELEGRAM_RECOVERY_REASON,
    confirmation: process.env.XPENSEGO_TELEGRAM_RECOVERY_CONFIRMATION,
  }).pipe(
    Effect.mapError(
      () => new TelegramDeliveryRecoveryCommandFailed({ reason: "invalid_configuration" }),
    ),
  );
  const result = yield* recoverTelegramDelivery({
    recoveryId: environment.recoveryId,
    outboundMessageId: environment.outboundMessageId,
    expectedErrorCode: environment.expectedErrorCode,
    reason: environment.reason,
  }).pipe(
    Effect.provide(
      Layer.merge(
        makePostgresTelegramDeliveryRecoveryStoreLayer(databaseUrl),
        makeCloudflareQueueApiPublicationLayer({
          accountId: environment.accountId,
          queueId: environment.queueId,
          apiToken: Redacted.make(environment.apiToken),
        }).pipe(Layer.provide(NodeHttpClient.layer)),
      ),
    ),
    Effect.mapError((error) => {
      switch (error._tag) {
        case "TelegramDeliveryRecoveryPersistenceUnavailable":
          return new TelegramDeliveryRecoveryCommandFailed({
            reason: "persistence_unavailable",
          });
        case "OutboxPublicationUnavailable":
          return new TelegramDeliveryRecoveryCommandFailed({ reason: "queue_unavailable" });
        case "OutboxPublicationOutcomeUnknown":
          return new TelegramDeliveryRecoveryCommandFailed({ reason: "queue_outcome_unknown" });
        case "TelegramDeliveryRecoveryStateConflict":
          return new TelegramDeliveryRecoveryCommandFailed({ reason: "state_conflict" });
      }
    }),
  );
  if (result._tag === "NotRecoverable") {
    yield* Effect.logWarning("Telegram delivery recovery was refused", {
      outboundMessageId: environment.outboundMessageId,
      recoveryId: environment.recoveryId,
      refusalReason: result.reason,
    });
    return yield* new TelegramDeliveryRecoveryCommandFailed({ reason: "not_recoverable" });
  }

  yield* Effect.logInfo("Telegram delivery recovery queued", {
    outboundMessageId: environment.outboundMessageId,
    recoveryId: environment.recoveryId,
    publication: result.publication,
  });
}).pipe(Effect.scoped);

NodeRuntime.runMain(program);
