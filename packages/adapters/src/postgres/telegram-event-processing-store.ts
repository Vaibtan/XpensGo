import { PgClient } from "@effect/sql-pg";
import { InboundEventId } from "@xpensego/domain/channel/inbound-event";
import {
  TelegramEventProcessingPersistenceUnavailable,
  TelegramEventProcessingStore,
  TelegramProcessingClaimId,
  type ClaimTelegramEventInput,
  type CompleteTelegramEventInput,
  type EnforceTelegramUserLimitInput,
  type TelegramEventProcessingStoreService,
} from "@xpensego/domain/channel/process-telegram-event";
import {
  OutboundChannelMessageId,
  TelegramReplyIntentV1,
} from "@xpensego/domain/channel/outbound-channel-intent";
import { PersistedTelegramEventV1 } from "@xpensego/domain/channel/telegram-event";
import { Clock, Effect, Layer, Schema, type Redacted } from "effect";

const ClaimRow = Schema.Struct({
  inboundEventId: InboundEventId,
  normalizedPayload: PersistedTelegramEventV1,
  processingStatus: Schema.String,
  processingClaimedUntil: Schema.NullOr(Schema.DateFromSelf),
  abuseAllowed: Schema.NullOr(Schema.Boolean),
});

const AbuseWindowRow = Schema.Struct({ eventCount: Schema.Int.pipe(Schema.positive()) });

const CompletionRow = Schema.Struct({
  normalizedPayload: PersistedTelegramEventV1,
});

const InsertedOutboundRow = Schema.Struct({ outboundMessageId: OutboundChannelMessageId });
const GeneratedClaimRow = Schema.Struct({ claimId: TelegramProcessingClaimId });
const UserAbuseStateRow = Schema.Struct({ userAbuseAllowed: Schema.NullOr(Schema.Boolean) });

function persistenceUnavailable(
  operation: TelegramEventProcessingPersistenceUnavailable["operation"],
): TelegramEventProcessingPersistenceUnavailable {
  return new TelegramEventProcessingPersistenceUnavailable({
    operation,
    reason: "database_unavailable",
  });
}

function observePersistenceFailure(
  operation: TelegramEventProcessingPersistenceUnavailable["operation"],
  cause: unknown,
) {
  return Effect.logWarning("PostgreSQL Telegram processing operation failed", {
    operation,
    causeTag: cause instanceof Error ? cause.name : "UnknownFailure",
  });
}

/** PostgreSQL Telegram processing implementation that requires an already-scoped client. */
export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;

  const claim: TelegramEventProcessingStoreService["claim"] = Effect.fn(
    "PostgresTelegramEventProcessing.claim",
  )(function* (input: ClaimTelegramEventInput) {
    const operation = Effect.gen(function* () {
      const nowMillis = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{
        readonly abuseAllowed: unknown;
        readonly inboundEventId: unknown;
        readonly normalizedPayload: unknown;
        readonly processingClaimedUntil: unknown;
        readonly processingStatus: unknown;
      }>`
        SELECT
          event.id AS "inboundEventId",
          event.normalized_payload AS "normalizedPayload",
          event.processing_status AS "processingStatus",
          event.processing_claimed_until AS "processingClaimedUntil",
          event.abuse_allowed AS "abuseAllowed"
        FROM outbox_messages AS outbox
        INNER JOIN inbound_channel_events AS event ON event.id = outbox.inbound_event_id
        WHERE outbox.id = ${input.outboxMessageId}
          AND outbox.kind = 'channel.event.received.v1'
          AND event.channel = 'telegram'
          AND event.normalized_payload IS NOT NULL
        FOR UPDATE OF event
      `;
      if (rows.length === 0) {
        return { _tag: "NotFound" } as const;
      }

      const row = yield* Schema.decodeUnknown(ClaimRow)(rows[0]);
      if (["processed", "suppressed"].includes(row.processingStatus)) {
        return { _tag: "Duplicate" } as const;
      }
      if (
        row.processingStatus === "processing" &&
        row.processingClaimedUntil !== null &&
        row.processingClaimedUntil.getTime() > nowMillis
      ) {
        return {
          _tag: "Deferred",
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((row.processingClaimedUntil.getTime() - nowMillis) / 1_000),
          ),
        } as const;
      }
      if (row.abuseAllowed === false) {
        return { _tag: "RateLimited" } as const;
      }

      if (row.abuseAllowed === null) {
        const [systemWindow] = yield* sql<{ readonly eventCount: unknown }>`
          INSERT INTO channel_abuse_windows (
            channel,
            scope_type,
            scope_key,
            window_started_at,
            event_count
          )
          VALUES ('telegram', 'system', 'global', date_trunc('minute', CURRENT_TIMESTAMP), 1)
          ON CONFLICT (channel, scope_type, scope_key, window_started_at) DO UPDATE
          SET
            event_count = channel_abuse_windows.event_count + 1,
            updated_at = CURRENT_TIMESTAMP
          RETURNING event_count AS "eventCount"
        `;
        const [identityWindow] = yield* sql<{ readonly eventCount: unknown }>`
          INSERT INTO channel_abuse_windows (
            channel,
            scope_type,
            scope_key,
            window_started_at,
            event_count
          )
          VALUES (
            'telegram',
            'identity',
            ${row.normalizedPayload.externalAccountId},
            date_trunc('minute', CURRENT_TIMESTAMP),
            1
          )
          ON CONFLICT (channel, scope_type, scope_key, window_started_at) DO UPDATE
          SET
            event_count = channel_abuse_windows.event_count + 1,
            updated_at = CURRENT_TIMESTAMP
          RETURNING event_count AS "eventCount"
        `;
        const system = yield* Schema.decodeUnknown(AbuseWindowRow)(systemWindow);
        const identity = yield* Schema.decodeUnknown(AbuseWindowRow)(identityWindow);
        const allowed =
          system.eventCount <= input.policy.systemPerMinute &&
          identity.eventCount <= input.policy.perIdentityPerMinute;
        if (!allowed) {
          yield* sql`
            UPDATE inbound_channel_events
            SET
              processing_status = 'suppressed',
              processing_outcome = 'abuse_limited',
              processed_at = CURRENT_TIMESTAMP,
              processing_claim_id = NULL,
              processing_claimed_until = NULL,
              abuse_checked_at = CURRENT_TIMESTAMP,
              abuse_allowed = FALSE
            WHERE id = ${row.inboundEventId}
          `;
          return { _tag: "RateLimited" } as const;
        }
      }

      const [generated] = yield* sql<{ readonly claimId: unknown }>`
        SELECT gen_random_uuid() AS "claimId"
      `;
      const { claimId } = yield* Schema.decodeUnknown(GeneratedClaimRow)(generated);
      yield* sql`
        UPDATE inbound_channel_events
        SET
          processing_status = 'processing',
          processing_claim_id = ${claimId},
          processing_claimed_until = CURRENT_TIMESTAMP
            + (${input.policy.leaseSeconds} * INTERVAL '1 second'),
          processing_attempts = processing_attempts + 1,
          abuse_checked_at = COALESCE(abuse_checked_at, CURRENT_TIMESTAMP),
          abuse_allowed = COALESCE(abuse_allowed, TRUE)
        WHERE id = ${row.inboundEventId}
      `;

      return {
        _tag: "Claimed",
        claimId,
        inboundEventId: row.inboundEventId,
        event: row.normalizedPayload,
      } as const;
    });

    return yield* sql.withTransaction(operation).pipe(
      Effect.tapError((cause) => observePersistenceFailure("claimTelegramEvent", cause)),
      Effect.mapError(() => persistenceUnavailable("claimTelegramEvent")),
    );
  });

  const complete: TelegramEventProcessingStoreService["complete"] = Effect.fn(
    "PostgresTelegramEventProcessing.complete",
  )(function* (input: CompleteTelegramEventInput) {
    const operation = Effect.gen(function* () {
      const rows = yield* sql<{ readonly normalizedPayload: unknown }>`
        SELECT normalized_payload AS "normalizedPayload"
        FROM inbound_channel_events
        WHERE id = ${input.inboundEventId}
          AND processing_status = 'processing'
          AND processing_claim_id = ${input.claimId}
        FOR UPDATE
      `;
      if (rows.length !== 1) {
        return yield* Effect.fail(persistenceUnavailable("completeTelegramEvent"));
      }
      const { normalizedPayload } = yield* Schema.decodeUnknown(CompletionRow)(rows[0]);
      const actor = input.completion._tag === "UnscopedReply" ? undefined : input.completion.actor;
      const processingOutcome =
        input.completion._tag === "LinkedTextAccepted"
          ? "normalized_text_accepted"
          : input.completion._tag === "ScopedReply"
            ? "scoped_reply_created"
            : "unscoped_reply_created";

      yield* sql`
        UPDATE inbound_channel_events
        SET
          owner_user_id = ${actor?.userId ?? null},
          ledger_id = ${actor?.ledgerId ?? null},
          processing_status = 'processed',
          processing_outcome = ${processingOutcome},
          processed_at = CURRENT_TIMESTAMP,
          processing_claim_id = NULL,
          processing_claimed_until = NULL
        WHERE id = ${input.inboundEventId}
          AND processing_claim_id = ${input.claimId}
      `;

      if (input.completion._tag === "LinkedTextAccepted") {
        yield* sql`
          INSERT INTO normalized_channel_commands (
            inbound_event_id,
            owner_user_id,
            ledger_id,
            channel_identity_id,
            channel,
            external_message_id,
            command_text,
            occurred_at,
            correlation_id
          )
          VALUES (
            ${input.inboundEventId},
            ${input.completion.actor.userId},
            ${input.completion.actor.ledgerId},
            ${input.completion.actor.channelIdentityId},
            'telegram',
            ${normalizedPayload.externalMessageId},
            ${input.completion.text},
            ${new Date(normalizedPayload.occurredAtMillis)},
            ${input.correlationId}
          )
        `;
      }

      const intent: TelegramReplyIntentV1 = input.completion.intent;
      const outboundRows = yield* sql<{ readonly outboundMessageId: unknown }>`
        INSERT INTO outbound_channel_messages (
          inbound_event_id,
          owner_user_id,
          ledger_id,
          channel_identity_id,
          channel,
          external_conversation_id,
          intent,
          correlation_id
        )
        VALUES (
          ${input.inboundEventId},
          ${actor?.userId ?? null},
          ${actor?.ledgerId ?? null},
          ${actor?.channelIdentityId ?? null},
          'telegram',
          ${normalizedPayload.externalConversationId},
          ${sql.json(intent)},
          ${input.correlationId}
        )
        RETURNING id AS "outboundMessageId"
      `;
      const { outboundMessageId } = yield* Schema.decodeUnknown(InsertedOutboundRow)(
        outboundRows[0],
      );
      yield* sql`
        INSERT INTO outbox_messages (
          inbound_event_id,
          owner_user_id,
          ledger_id,
          outbound_message_id,
          kind,
          payload
        )
        VALUES (
          ${input.inboundEventId},
          ${actor?.userId ?? null},
          ${actor?.ledgerId ?? null},
          ${outboundMessageId},
          'channel.reply.requested.v1',
          ${sql.json({
            version: 1,
            kind: "channel.reply.requested.v1",
            outboundMessageId,
            correlationId: input.correlationId,
          })}
        )
      `;

      return { _tag: "Completed", outboundMessageId } as const;
    });

    return yield* sql.withTransaction(operation).pipe(
      Effect.tapError((cause) => observePersistenceFailure("completeTelegramEvent", cause)),
      Effect.mapError(() => persistenceUnavailable("completeTelegramEvent")),
    );
  });

  const enforceUserLimit: TelegramEventProcessingStoreService["enforceUserLimit"] = Effect.fn(
    "PostgresTelegramEventProcessing.enforceUserLimit",
  )(function* (input: EnforceTelegramUserLimitInput) {
    const operation = Effect.gen(function* () {
      const rows = yield* sql<{ readonly userAbuseAllowed: unknown }>`
        SELECT user_abuse_allowed AS "userAbuseAllowed"
        FROM inbound_channel_events
        WHERE id = ${input.inboundEventId}
          AND processing_status = 'processing'
          AND processing_claim_id = ${input.claimId}
        FOR UPDATE
      `;
      if (rows.length !== 1) {
        return yield* Effect.fail(persistenceUnavailable("enforceTelegramUserLimit"));
      }
      const state = yield* Schema.decodeUnknown(UserAbuseStateRow)(rows[0]);
      if (state.userAbuseAllowed !== null) {
        return state.userAbuseAllowed
          ? ({ _tag: "Allowed" } as const)
          : ({ _tag: "RateLimited" } as const);
      }

      const [window] = yield* sql<{ readonly eventCount: unknown }>`
        INSERT INTO channel_abuse_windows (
          channel,
          scope_type,
          scope_key,
          window_started_at,
          event_count
        )
        VALUES (
          'telegram',
          'user',
          ${input.userId},
          date_trunc('minute', CURRENT_TIMESTAMP),
          1
        )
        ON CONFLICT (channel, scope_type, scope_key, window_started_at) DO UPDATE
        SET
          event_count = channel_abuse_windows.event_count + 1,
          updated_at = CURRENT_TIMESTAMP
        RETURNING event_count AS "eventCount"
      `;
      const count = yield* Schema.decodeUnknown(AbuseWindowRow)(window);
      const allowed = count.eventCount <= input.maximumEventsPerMinute;
      if (allowed) {
        yield* sql`
          UPDATE inbound_channel_events
          SET
            user_abuse_checked_at = CURRENT_TIMESTAMP,
            user_abuse_allowed = TRUE
          WHERE id = ${input.inboundEventId}
            AND processing_claim_id = ${input.claimId}
        `;
        return { _tag: "Allowed" } as const;
      }

      yield* sql`
        UPDATE inbound_channel_events
        SET
          processing_status = 'suppressed',
          processing_outcome = 'user_abuse_limited',
          processed_at = CURRENT_TIMESTAMP,
          processing_claim_id = NULL,
          processing_claimed_until = NULL,
          user_abuse_checked_at = CURRENT_TIMESTAMP,
          user_abuse_allowed = FALSE
        WHERE id = ${input.inboundEventId}
          AND processing_claim_id = ${input.claimId}
      `;
      return { _tag: "RateLimited" } as const;
    });

    return yield* sql.withTransaction(operation).pipe(
      Effect.tapError((cause) => observePersistenceFailure("enforceTelegramUserLimit", cause)),
      Effect.mapError(() => persistenceUnavailable("enforceTelegramUserLimit")),
    );
  });

  const release: TelegramEventProcessingStoreService["release"] = Effect.fn(
    "PostgresTelegramEventProcessing.release",
  )(function* (input) {
    return yield* sql`
      UPDATE inbound_channel_events
      SET
        processing_status = 'pending',
        processing_claim_id = NULL,
        processing_claimed_until = NULL
      WHERE id = ${input.inboundEventId}
        AND processing_status = 'processing'
        AND processing_claim_id = ${input.claimId}
    `.pipe(
      Effect.asVoid,
      Effect.tapError((cause) => observePersistenceFailure("releaseTelegramEvent", cause)),
      Effect.mapError(() => persistenceUnavailable("releaseTelegramEvent")),
    );
  });

  return TelegramEventProcessingStore.of({ claim, complete, enforceUserLimit, release });
});

/** Dependency-preserving Telegram processing Layer for an existing PostgreSQL client. */
export const layerWithoutDependencies = Layer.effect(TelegramEventProcessingStore, make);

/** Construct invocation-scoped PostgreSQL Telegram event processing. */
export function makePostgresTelegramEventProcessingStoreLayer(
  databaseUrl: Redacted.Redacted<string>,
) {
  const clientLayer = PgClient.layer({
    url: databaseUrl,
    applicationName: "xpensego-telegram-processing",
    connectTimeout: "5 seconds",
    idleTimeout: "1 second",
    maxConnections: 4,
  }).pipe(
    Layer.tapError((cause) => observePersistenceFailure("connectTelegramEventProcessing", cause)),
    Layer.mapError(() => persistenceUnavailable("connectTelegramEventProcessing")),
  );

  return layerWithoutDependencies.pipe(Layer.provide(clientLayer));
}
