import { PgClient } from "@effect/sql-pg";
import {
  AuthUserId,
  ChannelActorContext,
  WebActorContext,
} from "@xpensego/domain/identity/actor-context";
import { ChannelIdentityId, EpochMillis } from "@xpensego/domain/identity/channel-identity";
import {
  ChannelIdentityNotFound,
  IdentityAuthorityNotFound,
  IdentityPersistenceUnavailable,
  IdentityStore,
  TelegramIdentityNotLinked,
  type ChangeUserTimezoneInput,
  type ConsumeTelegramLinkChallengeStoreOutcome,
  type ConsumeTelegramLinkChallengeStoreInput,
  type ConsumeTelegramUnlinkChallengeStoreOutcome,
  type ConsumeTelegramUnlinkChallengeStoreInput,
  type PersistTelegramLinkChallengeOutcome,
  type PersistTelegramLinkChallengeInput,
  type PersistTelegramUnlinkChallengeInput,
  type ReadIdentityOverviewInput,
  type ResolveTelegramActorInput,
  type ResolveWebActorInput,
} from "@xpensego/domain/identity/identity";
import { UserId } from "@xpensego/domain/identity/user-id";
import { UserTimezone } from "@xpensego/domain/identity/user-timezone";
import { LedgerId } from "@xpensego/domain/ledger/ledger-id";
import { Effect, Layer, Schema, type Redacted } from "effect";

const WebActorRow = Schema.Struct({
  authUserId: AuthUserId,
  userId: UserId,
  ledgerId: LedgerId,
  timezone: UserTimezone,
});

const ChallengeRateStateRow = Schema.Struct({
  challengeCount: Schema.Int.pipe(Schema.nonNegative()),
  oldestCreatedAt: Schema.NullOr(Schema.DateFromSelf),
});

const TelegramIdentityRow = Schema.Struct({
  channelIdentityId: ChannelIdentityId,
  linkedAt: Schema.DateFromSelf,
});

const LinkChallengeRow = Schema.Struct({
  userId: UserId,
  ledgerId: LedgerId,
  expiresAt: Schema.DateFromSelf,
  consumedAt: Schema.NullOr(Schema.DateFromSelf),
});

const UnlinkChallengeRow = Schema.Struct({
  channelIdentityId: ChannelIdentityId,
  consumedAt: Schema.NullOr(Schema.DateFromSelf),
  expiresAt: Schema.DateFromSelf,
  externalAccountId: Schema.String,
  unlinkedAt: Schema.NullOr(Schema.DateFromSelf),
});

const ExistingTelegramIdentityRow = Schema.Struct({
  userId: UserId,
});

const ChannelActorRow = Schema.Struct({
  channelIdentityId: ChannelIdentityId,
  userId: UserId,
  ledgerId: LedgerId,
  timezone: UserTimezone,
});

function observeIdentityFailure(operation: string, cause: unknown) {
  return Effect.logWarning("PostgreSQL Identity operation failed", {
    operation,
    causeTag: cause instanceof Error ? cause.name : "UnknownFailure",
  });
}

/** PostgreSQL Identity store that requires an already-scoped client. */
export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;

  const resolveWebActor = Effect.fn("PostgresIdentityStore.resolveWebActor")(function* (
    input: ResolveWebActorInput,
  ) {
    const transaction = Effect.gen(function* () {
      yield* sql`
        INSERT INTO users (auth_user_id)
        VALUES (${input.authUserId})
        ON CONFLICT (auth_user_id) DO NOTHING
      `;
      yield* sql`
        INSERT INTO ledgers (owner_user_id)
        SELECT id
        FROM users
        WHERE auth_user_id = ${input.authUserId}
        ON CONFLICT (owner_user_id) DO NOTHING
      `;
      const rows = yield* sql<{
        readonly authUserId: unknown;
        readonly ledgerId: unknown;
        readonly timezone: unknown;
        readonly userId: unknown;
      }>`
        SELECT
          users.auth_user_id AS "authUserId",
          users.id AS "userId",
          users.timezone,
          ledgers.id AS "ledgerId"
        FROM users
        INNER JOIN ledgers ON ledgers.owner_user_id = users.id
        WHERE users.auth_user_id = ${input.authUserId}
      `;
      const row = yield* Schema.decodeUnknown(WebActorRow)(rows[0]);
      return yield* Schema.decodeUnknown(WebActorContext)({
        _tag: "WebActor",
        userId: row.userId,
        ledgerId: row.ledgerId,
        timezone: row.timezone,
        correlationId: input.correlationId,
        authenticationStrength: "session",
      });
    });

    return yield* sql.withTransaction(transaction).pipe(
      Effect.tapError((cause) => observeIdentityFailure("resolveWebActor", cause)),
      Effect.mapError(
        () =>
          new IdentityPersistenceUnavailable({
            operation: "resolveWebActor",
            reason: "database_unavailable",
          }),
      ),
    );
  });

  const changeUserTimezone = Effect.fn("PostgresIdentityStore.changeUserTimezone")(function* (
    input: ChangeUserTimezoneInput,
  ) {
    return yield* sql`
      UPDATE users
      SET timezone = ${input.timezone}
      WHERE id = ${input.actor.userId}
        AND EXISTS (
          SELECT 1
          FROM ledgers
          WHERE ledgers.id = ${input.actor.ledgerId}
            AND ledgers.owner_user_id = users.id
        )
      RETURNING id
    `.pipe(
      Effect.flatMap((rows) =>
        rows.length === 1
          ? Effect.succeed<typeof WebActorContext.Type>({
              _tag: "WebActor",
              userId: input.actor.userId,
              ledgerId: input.actor.ledgerId,
              timezone: input.timezone,
              correlationId: input.actor.correlationId,
              authenticationStrength: "session",
            })
          : Effect.fail(new IdentityAuthorityNotFound({ operation: "changeUserTimezone" })),
      ),
      Effect.tapError((cause) =>
        cause instanceof IdentityAuthorityNotFound
          ? Effect.void
          : observeIdentityFailure("changeUserTimezone", cause),
      ),
      Effect.mapError((cause) =>
        cause instanceof IdentityAuthorityNotFound
          ? cause
          : new IdentityPersistenceUnavailable({
              operation: "changeUserTimezone",
              reason: "database_unavailable",
            }),
      ),
    );
  });

  const listTelegramIdentities = Effect.fn("PostgresIdentityStore.listTelegramIdentities")(
    function* (input: ReadIdentityOverviewInput) {
      return yield* sql<{
        readonly channelIdentityId: unknown;
        readonly linkedAt: unknown;
      }>`
      SELECT id AS "channelIdentityId", linked_at AS "linkedAt"
      FROM channel_identities
      WHERE user_id = ${input.actor.userId}
        AND ledger_id = ${input.actor.ledgerId}
        AND channel = 'telegram'
        AND unlinked_at IS NULL
      ORDER BY linked_at, id
    `.pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Array(TelegramIdentityRow))),
        Effect.map((rows) =>
          rows.map((row) => ({
            channelIdentityId: row.channelIdentityId,
            linkedAtMillis: EpochMillis.make(row.linkedAt.getTime()),
          })),
        ),
        Effect.tapError((cause) => observeIdentityFailure("listTelegramIdentities", cause)),
        Effect.mapError(
          () =>
            new IdentityPersistenceUnavailable({
              operation: "listTelegramIdentities",
              reason: "database_unavailable",
            }),
        ),
      );
    },
  );

  const createTelegramLinkChallenge = Effect.fn(
    "PostgresIdentityStore.createTelegramLinkChallenge",
  )(function* (input: PersistTelegramLinkChallengeInput) {
    const transaction = Effect.gen(function* () {
      const authority = yield* sql`
        SELECT users.id
        FROM users
        INNER JOIN ledgers ON ledgers.owner_user_id = users.id
        WHERE users.id = ${input.actor.userId}
          AND ledgers.id = ${input.actor.ledgerId}
        FOR UPDATE OF users
      `;
      if (authority.length !== 1) {
        return yield* new IdentityAuthorityNotFound({
          operation: "createTelegramLinkChallenge",
        });
      }

      const rateRows = yield* sql<{
        readonly challengeCount: unknown;
        readonly oldestCreatedAt: unknown;
      }>`
        SELECT
          count(*)::integer AS "challengeCount",
          min(created_at) AS "oldestCreatedAt"
        FROM channel_link_challenges
        WHERE user_id = ${input.actor.userId}
          AND created_at >= ${new Date(input.rateLimitSinceMillis)}
      `;
      const rateState = yield* Schema.decodeUnknown(ChallengeRateStateRow)(rateRows[0]);
      if (rateState.challengeCount >= input.maximumChallenges) {
        const oldestMillis = rateState.oldestCreatedAt?.getTime() ?? input.createdAtMillis;
        const windowMillis = input.createdAtMillis - input.rateLimitSinceMillis;
        return {
          _tag: "RateLimited",
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((oldestMillis + windowMillis - input.createdAtMillis) / 1_000),
          ),
        } satisfies PersistTelegramLinkChallengeOutcome;
      }

      yield* sql`
        INSERT INTO channel_link_challenges (
          user_id,
          ledger_id,
          channel,
          purpose,
          token_hash,
          created_at,
          expires_at
        )
        VALUES (
          ${input.actor.userId},
          ${input.actor.ledgerId},
          'telegram',
          'link',
          ${input.tokenDigest},
          ${new Date(input.createdAtMillis)},
          ${new Date(input.expiresAtMillis)}
        )
      `;
      return { _tag: "Stored" } satisfies PersistTelegramLinkChallengeOutcome;
    });

    return yield* sql.withTransaction(transaction).pipe(
      Effect.tapError((cause) =>
        cause instanceof IdentityAuthorityNotFound
          ? Effect.void
          : observeIdentityFailure("createTelegramLinkChallenge", cause),
      ),
      Effect.mapError((cause) =>
        cause instanceof IdentityAuthorityNotFound
          ? cause
          : new IdentityPersistenceUnavailable({
              operation: "createTelegramLinkChallenge",
              reason: "database_unavailable",
            }),
      ),
    );
  });

  const consumeTelegramLinkChallenge = Effect.fn(
    "PostgresIdentityStore.consumeTelegramLinkChallenge",
  )(function* (input: ConsumeTelegramLinkChallengeStoreInput) {
    const transaction = Effect.gen(function* () {
      const challengeRows = yield* sql<{
        readonly consumedAt: unknown;
        readonly expiresAt: unknown;
        readonly ledgerId: unknown;
        readonly userId: unknown;
      }>`
        SELECT
          user_id AS "userId",
          ledger_id AS "ledgerId",
          expires_at AS "expiresAt",
          consumed_at AS "consumedAt"
        FROM channel_link_challenges
        WHERE token_hash = ${input.tokenDigest}
          AND channel = 'telegram'
          AND purpose = 'link'
        FOR UPDATE
      `;
      if (challengeRows.length === 0) {
        return {
          _tag: "ChallengeNotFound",
        } satisfies ConsumeTelegramLinkChallengeStoreOutcome;
      }
      const challenge = yield* Schema.decodeUnknown(LinkChallengeRow)(challengeRows[0]);
      if (challenge.consumedAt !== null) {
        return {
          _tag: "ChallengeAlreadyConsumed",
        } satisfies ConsumeTelegramLinkChallengeStoreOutcome;
      }

      const consumedAt = new Date(input.consumedAtMillis);
      if (challenge.expiresAt.getTime() <= input.consumedAtMillis) {
        yield* sql`
          UPDATE channel_link_challenges
          SET consumed_at = ${consumedAt}
          WHERE token_hash = ${input.tokenDigest}
        `;
        return {
          _tag: "ChallengeExpired",
        } satisfies ConsumeTelegramLinkChallengeStoreOutcome;
      }

      const insertedRows = yield* sql<{
        readonly channelIdentityId: unknown;
        readonly linkedAt: unknown;
      }>`
        INSERT INTO channel_identities (
          user_id,
          ledger_id,
          channel,
          external_account_id,
          linked_at
        )
        VALUES (
          ${challenge.userId},
          ${challenge.ledgerId},
          'telegram',
          ${input.externalAccountId},
          ${consumedAt}
        )
        ON CONFLICT (channel, external_account_id) WHERE unlinked_at IS NULL
        DO NOTHING
        RETURNING id AS "channelIdentityId", linked_at AS "linkedAt"
      `;

      yield* sql`
        UPDATE channel_link_challenges
        SET consumed_at = ${consumedAt}
        WHERE token_hash = ${input.tokenDigest}
      `;

      if (insertedRows.length === 0) {
        const existingRows = yield* sql<{ readonly userId: unknown }>`
          SELECT user_id AS "userId"
          FROM channel_identities
          WHERE channel = 'telegram'
            AND external_account_id = ${input.externalAccountId}
            AND unlinked_at IS NULL
        `;
        yield* Schema.decodeUnknown(ExistingTelegramIdentityRow)(existingRows[0]);
        return {
          _tag: "TelegramIdentityAlreadyLinked",
        } satisfies ConsumeTelegramLinkChallengeStoreOutcome;
      }

      const inserted = yield* Schema.decodeUnknown(TelegramIdentityRow)(insertedRows[0]);
      const actorRows = yield* sql<{
        readonly channelIdentityId: unknown;
        readonly ledgerId: unknown;
        readonly timezone: unknown;
        readonly userId: unknown;
      }>`
        SELECT
          identity.id AS "channelIdentityId",
          identity.user_id AS "userId",
          identity.ledger_id AS "ledgerId",
          users.timezone
        FROM channel_identities AS identity
        INNER JOIN users ON users.id = identity.user_id
        WHERE identity.id = ${inserted.channelIdentityId}
      `;
      const actorRow = yield* Schema.decodeUnknown(ChannelActorRow)(actorRows[0]);
      const actor = yield* Schema.decodeUnknown(ChannelActorContext)({
        _tag: "ChannelActor",
        userId: actorRow.userId,
        ledgerId: actorRow.ledgerId,
        timezone: actorRow.timezone,
        correlationId: input.correlationId,
        authenticationStrength: "linked_channel",
        channel: "telegram",
        channelIdentityId: actorRow.channelIdentityId,
      });
      return {
        _tag: "TelegramIdentityLinked",
        channelIdentityId: actorRow.channelIdentityId,
        actor,
      } satisfies ConsumeTelegramLinkChallengeStoreOutcome;
    });

    return yield* sql.withTransaction(transaction).pipe(
      Effect.tapError((cause) => observeIdentityFailure("consumeTelegramLinkChallenge", cause)),
      Effect.mapError(
        () =>
          new IdentityPersistenceUnavailable({
            operation: "consumeTelegramLinkChallenge",
            reason: "database_unavailable",
          }),
      ),
    );
  });

  const createTelegramUnlinkChallenge = Effect.fn(
    "PostgresIdentityStore.createTelegramUnlinkChallenge",
  )(function* (input: PersistTelegramUnlinkChallengeInput) {
    const transaction = Effect.gen(function* () {
      const authority = yield* sql`
        SELECT users.id
        FROM users
        INNER JOIN ledgers ON ledgers.owner_user_id = users.id
        WHERE users.id = ${input.actor.userId}
          AND ledgers.id = ${input.actor.ledgerId}
        FOR UPDATE OF users
      `;
      if (authority.length !== 1) {
        return yield* new IdentityAuthorityNotFound({
          operation: "createTelegramUnlinkChallenge",
        });
      }

      const target = yield* sql`
        SELECT id
        FROM channel_identities
        WHERE id = ${input.channelIdentityId}
          AND user_id = ${input.actor.userId}
          AND ledger_id = ${input.actor.ledgerId}
          AND channel = 'telegram'
          AND unlinked_at IS NULL
      `;
      if (target.length !== 1) {
        return yield* new ChannelIdentityNotFound();
      }

      const rateRows = yield* sql<{
        readonly challengeCount: unknown;
        readonly oldestCreatedAt: unknown;
      }>`
        SELECT
          count(*)::integer AS "challengeCount",
          min(created_at) AS "oldestCreatedAt"
        FROM channel_link_challenges
        WHERE user_id = ${input.actor.userId}
          AND created_at >= ${new Date(input.rateLimitSinceMillis)}
      `;
      const rateState = yield* Schema.decodeUnknown(ChallengeRateStateRow)(rateRows[0]);
      if (rateState.challengeCount >= input.maximumChallenges) {
        const oldestMillis = rateState.oldestCreatedAt?.getTime() ?? input.createdAtMillis;
        const windowMillis = input.createdAtMillis - input.rateLimitSinceMillis;
        return {
          _tag: "RateLimited",
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((oldestMillis + windowMillis - input.createdAtMillis) / 1_000),
          ),
        } satisfies PersistTelegramLinkChallengeOutcome;
      }

      yield* sql`
        INSERT INTO channel_link_challenges (
          user_id,
          ledger_id,
          channel,
          purpose,
          token_hash,
          target_channel_identity_id,
          created_at,
          expires_at
        )
        VALUES (
          ${input.actor.userId},
          ${input.actor.ledgerId},
          'telegram',
          'unlink',
          ${input.tokenDigest},
          ${input.channelIdentityId},
          ${new Date(input.createdAtMillis)},
          ${new Date(input.expiresAtMillis)}
        )
      `;
      return { _tag: "Stored" } satisfies PersistTelegramLinkChallengeOutcome;
    });

    return yield* sql.withTransaction(transaction).pipe(
      Effect.tapError((cause) =>
        cause instanceof IdentityAuthorityNotFound || cause instanceof ChannelIdentityNotFound
          ? Effect.void
          : observeIdentityFailure("createTelegramUnlinkChallenge", cause),
      ),
      Effect.mapError((cause) =>
        cause instanceof IdentityAuthorityNotFound || cause instanceof ChannelIdentityNotFound
          ? cause
          : new IdentityPersistenceUnavailable({
              operation: "createTelegramUnlinkChallenge",
              reason: "database_unavailable",
            }),
      ),
    );
  });

  const consumeTelegramUnlinkChallenge = Effect.fn(
    "PostgresIdentityStore.consumeTelegramUnlinkChallenge",
  )(function* (input: ConsumeTelegramUnlinkChallengeStoreInput) {
    const transaction = Effect.gen(function* () {
      const challengeRows = yield* sql<{
        readonly channelIdentityId: unknown;
        readonly consumedAt: unknown;
        readonly expiresAt: unknown;
        readonly externalAccountId: unknown;
        readonly unlinkedAt: unknown;
      }>`
        SELECT
          challenge.target_channel_identity_id AS "channelIdentityId",
          challenge.expires_at AS "expiresAt",
          challenge.consumed_at AS "consumedAt",
          identity.external_account_id AS "externalAccountId",
          identity.unlinked_at AS "unlinkedAt"
        FROM channel_link_challenges AS challenge
        INNER JOIN channel_identities AS identity
          ON identity.id = challenge.target_channel_identity_id
          AND identity.user_id = challenge.user_id
          AND identity.ledger_id = challenge.ledger_id
        WHERE challenge.token_hash = ${input.tokenDigest}
          AND challenge.channel = 'telegram'
          AND challenge.purpose = 'unlink'
        FOR UPDATE OF challenge, identity
      `;
      if (challengeRows.length === 0) {
        return {
          _tag: "ChallengeNotFound",
        } satisfies ConsumeTelegramUnlinkChallengeStoreOutcome;
      }

      const challenge = yield* Schema.decodeUnknown(UnlinkChallengeRow)(challengeRows[0]);
      if (challenge.consumedAt !== null) {
        return {
          _tag: "ChallengeAlreadyConsumed",
        } satisfies ConsumeTelegramUnlinkChallengeStoreOutcome;
      }

      const consumedAt = new Date(input.consumedAtMillis);
      if (challenge.expiresAt.getTime() <= input.consumedAtMillis) {
        yield* sql`
          UPDATE channel_link_challenges
          SET consumed_at = ${consumedAt}
          WHERE token_hash = ${input.tokenDigest}
        `;
        return {
          _tag: "ChallengeExpired",
        } satisfies ConsumeTelegramUnlinkChallengeStoreOutcome;
      }
      if (challenge.unlinkedAt !== null) {
        yield* sql`
          UPDATE channel_link_challenges
          SET consumed_at = ${consumedAt}
          WHERE token_hash = ${input.tokenDigest}
        `;
        return {
          _tag: "ChannelIdentityNotFound",
        } satisfies ConsumeTelegramUnlinkChallengeStoreOutcome;
      }
      if (challenge.externalAccountId !== input.externalAccountId) {
        return {
          _tag: "TelegramIdentityDoesNotMatchChallenge",
        } satisfies ConsumeTelegramUnlinkChallengeStoreOutcome;
      }

      const updated = yield* sql`
        UPDATE channel_identities
        SET unlinked_at = ${consumedAt}
        WHERE id = ${challenge.channelIdentityId}
          AND unlinked_at IS NULL
        RETURNING id
      `;
      if (updated.length !== 1) {
        return {
          _tag: "ChannelIdentityNotFound",
        } satisfies ConsumeTelegramUnlinkChallengeStoreOutcome;
      }
      yield* sql`
        UPDATE channel_link_challenges
        SET consumed_at = ${consumedAt}
        WHERE token_hash = ${input.tokenDigest}
      `;
      return {
        _tag: "TelegramIdentityUnlinked",
        channelIdentityId: challenge.channelIdentityId,
      } satisfies ConsumeTelegramUnlinkChallengeStoreOutcome;
    });

    return yield* sql.withTransaction(transaction).pipe(
      Effect.tapError((cause) => observeIdentityFailure("consumeTelegramUnlinkChallenge", cause)),
      Effect.mapError(
        () =>
          new IdentityPersistenceUnavailable({
            operation: "consumeTelegramUnlinkChallenge",
            reason: "database_unavailable",
          }),
      ),
    );
  });

  const resolveTelegramActor = Effect.fn("PostgresIdentityStore.resolveTelegramActor")(function* (
    input: ResolveTelegramActorInput,
  ) {
    return yield* sql<{
      readonly channelIdentityId: unknown;
      readonly ledgerId: unknown;
      readonly timezone: unknown;
      readonly userId: unknown;
    }>`
      SELECT
        identity.id AS "channelIdentityId",
        identity.user_id AS "userId",
        identity.ledger_id AS "ledgerId",
        users.timezone
      FROM channel_identities AS identity
      INNER JOIN users ON users.id = identity.user_id
      INNER JOIN ledgers
        ON ledgers.id = identity.ledger_id
        AND ledgers.owner_user_id = identity.user_id
      WHERE identity.channel = 'telegram'
        AND identity.external_account_id = ${input.externalAccountId}
        AND identity.unlinked_at IS NULL
    `.pipe(
      Effect.flatMap((rows) =>
        Effect.gen(function* () {
          if (rows.length !== 1) {
            return yield* new TelegramIdentityNotLinked();
          }
          return yield* Schema.decodeUnknown(ChannelActorRow)(rows[0]);
        }),
      ),
      Effect.flatMap((row) =>
        Schema.decodeUnknown(ChannelActorContext)({
          _tag: "ChannelActor",
          userId: row.userId,
          ledgerId: row.ledgerId,
          timezone: row.timezone,
          correlationId: input.correlationId,
          authenticationStrength: "linked_channel",
          channel: "telegram",
          channelIdentityId: row.channelIdentityId,
        }),
      ),
      Effect.tapError((cause) =>
        cause instanceof TelegramIdentityNotLinked
          ? Effect.void
          : observeIdentityFailure("resolveTelegramActor", cause),
      ),
      Effect.mapError((cause) =>
        cause instanceof TelegramIdentityNotLinked
          ? cause
          : new IdentityPersistenceUnavailable({
              operation: "resolveTelegramActor",
              reason: "database_unavailable",
            }),
      ),
    );
  });

  return IdentityStore.of({
    changeUserTimezone,
    consumeTelegramLinkChallenge,
    consumeTelegramUnlinkChallenge,
    createTelegramLinkChallenge,
    createTelegramUnlinkChallenge,
    listTelegramIdentities,
    resolveTelegramActor,
    resolveWebActor,
  });
});

/** Dependency-preserving Layer for compositions that already own a PostgreSQL client. */
export const layerWithoutDependencies = Layer.effect(IdentityStore, make);

/**
 * Construct the complete PostgreSQL Identity adapter for one runtime database URL.
 *
 * @param databaseUrl - Redacted runtime-role PostgreSQL connection URL.
 * @returns A scoped Layer that owns and releases its PostgreSQL pool.
 */
export function makePostgresIdentityStoreLayer(databaseUrl: Redacted.Redacted<string>) {
  const clientLayer = PgClient.layer({
    url: databaseUrl,
    applicationName: "xpensego-identity-store",
    connectTimeout: "5 seconds",
    idleTimeout: "1 second",
    maxConnections: 4,
  }).pipe(
    Layer.tapError((cause) => observeIdentityFailure("connectIdentityStore", cause)),
    Layer.mapError(
      () =>
        new IdentityPersistenceUnavailable({
          operation: "resolveWebActor",
          reason: "database_unavailable",
        }),
    ),
  );

  return layerWithoutDependencies.pipe(Layer.provide(clientLayer));
}
