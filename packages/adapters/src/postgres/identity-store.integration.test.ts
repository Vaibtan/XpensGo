import { SqlClient } from "@effect/sql";
import { PgClient } from "@effect/sql-pg";
import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { AuthUserId } from "@xpensego/domain/identity/actor-context";
import { TelegramExternalAccountId } from "@xpensego/domain/identity/channel-identity";
import {
  ChannelIdentityNotFound,
  ChannelLinkChallengeAlreadyConsumed,
  ChannelLinkChallengeExpired,
  ChannelLinkChallengeRateLimited,
  TelegramIdentityAlreadyLinked,
  TelegramIdentityNotLinked,
  changeUserTimezone,
  consumeTelegramLinkChallenge,
  consumeTelegramUnlinkChallenge,
  createTelegramLinkChallenge,
  createTelegramUnlinkChallenge,
  readIdentityOverview,
  resolveTelegramActor,
  resolveWebActor,
} from "@xpensego/domain/identity/identity";
import { UserTimezone } from "@xpensego/domain/identity/user-timezone";
import { Duration, Effect, Layer, Schema, TestClock, TestContext } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makePostgresIdentityStoreLayer } from "./identity-store.js";
import { makeIsolatedTestDatabase } from "./isolated-test-database.js";
import { webCryptoLinkChallengeLayer } from "../web-crypto/link-challenge-crypto.js";
import { runMigrations } from "./migrations.js";

const testDatabase = makeIsolatedTestDatabase("xpensego_identity_store_integration");
const migrationClientLayer = PgClient.layer({
  url: testDatabase.migrationUrl,
  applicationName: "xpensego-identity-store-fixtures",
  maxConnections: 1,
});

const authUserId = Schema.decodeUnknownSync(AuthUserId)("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const otherAuthUserId = Schema.decodeUnknownSync(AuthUserId)(
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
);
const correlationId = Schema.decodeUnknownSync(CorrelationId)(
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
);

const resetDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM channel_link_challenges`;
  yield* sql`DELETE FROM channel_identities`;
  yield* sql`DELETE FROM ledgers`;
  yield* sql`DELETE FROM users`;
  yield* sql`DELETE FROM auth_user`;
  yield* sql`
    INSERT INTO auth_user (id, name, email, "emailVerified", "updatedAt")
    VALUES
      (${authUserId}, 'Alpha One', 'alpha-one@example.test', TRUE, CURRENT_TIMESTAMP),
      (${otherAuthUserId}, 'Beta Two', 'beta-two@example.test', TRUE, CURRENT_TIMESTAMP)
  `;
}).pipe(Effect.provide(migrationClientLayer), Effect.scoped);

const readAuthorityCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [counts] = yield* sql<{
    readonly ledgerCount: number;
    readonly userCount: number;
  }>`
    SELECT
      (SELECT count(*)::integer FROM users) AS "userCount",
      (SELECT count(*)::integer FROM ledgers) AS "ledgerCount"
  `;
  return counts;
}).pipe(Effect.provide(migrationClientLayer), Effect.scoped);

describe("PostgreSQL Identity store", () => {
  beforeAll(async () => {
    await Effect.runPromise(testDatabase.recreate);
    await Effect.runPromise(runMigrations(testDatabase.migrationUrl));
  });

  afterAll(async () => {
    await Effect.runPromise(testDatabase.drop);
  });

  beforeEach(async () => {
    await Effect.runPromise(resetDatabase);
  });

  it("converges concurrent first-session resolution on one User and personal Ledger", async () => {
    const actors = await Effect.runPromise(
      Effect.all(
        [
          resolveWebActor({ authUserId, correlationId }),
          resolveWebActor({ authUserId, correlationId }),
        ],
        { concurrency: 2 },
      ).pipe(Effect.provide(makePostgresIdentityStoreLayer(testDatabase.runtimeUrl))),
    );

    expect(actors[0]).toEqual(actors[1]);
    expect(actors[0]).toMatchObject({
      _tag: "WebActor",
      authenticationStrength: "session",
      timezone: "Asia/Kolkata",
    });
    await expect(Effect.runPromise(readAuthorityCounts)).resolves.toEqual({
      ledgerCount: 1,
      userCount: 1,
    });
  });

  it("changes only the authenticated User timezone", async () => {
    const layer = makePostgresIdentityStoreLayer(testDatabase.runtimeUrl);
    const [firstActor, secondActor] = await Effect.runPromise(
      Effect.all(
        [
          resolveWebActor({ authUserId, correlationId }),
          resolveWebActor({ authUserId: otherAuthUserId, correlationId }),
        ],
        { concurrency: 2 },
      ).pipe(Effect.provide(layer)),
    );
    const timezone = Schema.decodeUnknownSync(UserTimezone)("Europe/London");

    const changed = await Effect.runPromise(
      changeUserTimezone({ actor: firstActor, timezone }).pipe(Effect.provide(layer)),
    );
    const [resolvedFirst, resolvedSecond] = await Effect.runPromise(
      Effect.all(
        [
          resolveWebActor({ authUserId, correlationId }),
          resolveWebActor({ authUserId: otherAuthUserId, correlationId }),
        ],
        { concurrency: 2 },
      ).pipe(Effect.provide(layer)),
    );

    expect(firstActor.userId).not.toBe(secondActor.userId);
    expect(firstActor.ledgerId).not.toBe(secondActor.ledgerId);
    expect(changed.timezone).toBe("Europe/London");
    expect(resolvedFirst.timezone).toBe("Europe/London");
    expect(resolvedSecond.timezone).toBe("Asia/Kolkata");
  });

  it("links one Telegram identity, resolves its ActorContext, and rejects challenge replay", async () => {
    const layer = makePostgresIdentityStoreLayer(testDatabase.runtimeUrl).pipe(
      Layer.merge(webCryptoLinkChallengeLayer),
    );
    const externalAccountId = Schema.decodeUnknownSync(TelegramExternalAccountId)("987654321");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const actor = yield* resolveWebActor({ authUserId, correlationId });
        const challenge = yield* createTelegramLinkChallenge({ actor });
        const linked = yield* consumeTelegramLinkChallenge({
          correlationId,
          externalAccountId,
          token: challenge.token,
        });
        const overview = yield* readIdentityOverview({ actor });
        const telegramActor = yield* resolveTelegramActor({ correlationId, externalAccountId });
        const replay = yield* consumeTelegramLinkChallenge({
          correlationId,
          externalAccountId,
          token: challenge.token,
        }).pipe(Effect.flip);
        return { actor, challenge, linked, overview, replay, telegramActor };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.challenge.expiresAtMillis).toBeGreaterThan(Date.now());
    expect(result.linked._tag).toBe("TelegramIdentityLinked");
    expect(result.overview.telegramIdentities).toEqual([
      expect.objectContaining({ channelIdentityId: result.linked.channelIdentityId }),
    ]);
    expect(result.telegramActor).toMatchObject({
      _tag: "ChannelActor",
      channel: "telegram",
      channelIdentityId: result.linked.channelIdentityId,
      ledgerId: result.actor.ledgerId,
      userId: result.actor.userId,
    });
    expect(result.replay).toBeInstanceOf(ChannelLinkChallengeAlreadyConsumed);
  });

  it("rejects a link challenge after its ten-minute lifetime", async () => {
    const layer = makePostgresIdentityStoreLayer(testDatabase.runtimeUrl).pipe(
      Layer.merge(webCryptoLinkChallengeLayer),
    );
    const externalAccountId = Schema.decodeUnknownSync(TelegramExternalAccountId)("222333444");

    const expired = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(1_700_000_000_000);
        const actor = yield* resolveWebActor({ authUserId, correlationId });
        const challenge = yield* createTelegramLinkChallenge({ actor });
        yield* TestClock.adjust(Duration.minutes(10));
        return yield* consumeTelegramLinkChallenge({
          correlationId,
          externalAccountId,
          token: challenge.token,
        }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer), Effect.provide(TestContext.TestContext)),
    );

    expect(expired).toBeInstanceOf(ChannelLinkChallengeExpired);
  });

  it("limits a User to five link or unlink challenges in one hour", async () => {
    const layer = makePostgresIdentityStoreLayer(testDatabase.runtimeUrl).pipe(
      Layer.merge(webCryptoLinkChallengeLayer),
    );

    const rejection = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(1_700_000_000_000);
        const actor = yield* resolveWebActor({ authUserId, correlationId });
        const externalAccountId = Schema.decodeUnknownSync(TelegramExternalAccountId)("555666777");
        const firstLinkChallenge = yield* createTelegramLinkChallenge({ actor });
        const linked = yield* consumeTelegramLinkChallenge({
          correlationId,
          externalAccountId,
          token: firstLinkChallenge.token,
        });
        yield* createTelegramUnlinkChallenge({
          actor,
          channelIdentityId: linked.channelIdentityId,
        });
        yield* Effect.all(
          Array.from({ length: 3 }, () => createTelegramLinkChallenge({ actor })),
          { concurrency: 1 },
        );
        return yield* createTelegramUnlinkChallenge({
          actor,
          channelIdentityId: linked.channelIdentityId,
        }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer), Effect.provide(TestContext.TestContext)),
    );

    expect(rejection).toBeInstanceOf(ChannelLinkChallengeRateLimited);
    if (rejection instanceof ChannelLinkChallengeRateLimited) {
      expect(rejection.retryAfterSeconds).toBe(3_600);
    }
  });

  it("preserves ownership through conflict, unlink, and safe relink", async () => {
    const layer = makePostgresIdentityStoreLayer(testDatabase.runtimeUrl).pipe(
      Layer.merge(webCryptoLinkChallengeLayer),
    );
    const externalAccountId = Schema.decodeUnknownSync(TelegramExternalAccountId)("123456789");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const firstActor = yield* resolveWebActor({ authUserId, correlationId });
        const secondActor = yield* resolveWebActor({
          authUserId: otherAuthUserId,
          correlationId,
        });
        const firstChallenge = yield* createTelegramLinkChallenge({ actor: firstActor });
        const firstLink = yield* consumeTelegramLinkChallenge({
          correlationId,
          externalAccountId,
          token: firstChallenge.token,
        });

        const conflictingChallenge = yield* createTelegramLinkChallenge({ actor: secondActor });
        const conflict = yield* consumeTelegramLinkChallenge({
          correlationId,
          externalAccountId,
          token: conflictingChallenge.token,
        }).pipe(Effect.flip);

        const foreignUnlink = yield* createTelegramUnlinkChallenge({
          actor: secondActor,
          channelIdentityId: firstLink.channelIdentityId,
        }).pipe(Effect.flip);

        const unlinkChallenge = yield* createTelegramUnlinkChallenge({
          actor: firstActor,
          channelIdentityId: firstLink.channelIdentityId,
        });
        const unlinked = yield* consumeTelegramUnlinkChallenge({
          correlationId,
          externalAccountId,
          token: unlinkChallenge.token,
        });
        const unlinkReplay = yield* consumeTelegramUnlinkChallenge({
          correlationId,
          externalAccountId,
          token: unlinkChallenge.token,
        }).pipe(Effect.flip);
        const notLinked = yield* resolveTelegramActor({ correlationId, externalAccountId }).pipe(
          Effect.flip,
        );

        const relinkChallenge = yield* createTelegramLinkChallenge({ actor: secondActor });
        const relinked = yield* consumeTelegramLinkChallenge({
          correlationId,
          externalAccountId,
          token: relinkChallenge.token,
        });
        const firstOverview = yield* readIdentityOverview({ actor: firstActor });
        const secondOverview = yield* readIdentityOverview({ actor: secondActor });
        const resolved = yield* resolveTelegramActor({ correlationId, externalAccountId });
        return {
          conflict,
          foreignUnlink,
          firstOverview,
          notLinked,
          relinked,
          resolved,
          secondActor,
          secondOverview,
          unlinked,
          unlinkReplay,
        };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.conflict).toBeInstanceOf(TelegramIdentityAlreadyLinked);
    expect(result.foreignUnlink).toBeInstanceOf(ChannelIdentityNotFound);
    expect(result.unlinked._tag).toBe("TelegramIdentityUnlinked");
    expect(result.unlinkReplay).toBeInstanceOf(ChannelLinkChallengeAlreadyConsumed);
    expect(result.notLinked).toBeInstanceOf(TelegramIdentityNotLinked);
    expect(result.firstOverview.telegramIdentities).toEqual([]);
    expect(result.secondOverview.telegramIdentities).toEqual([
      expect.objectContaining({ channelIdentityId: result.relinked.channelIdentityId }),
    ]);
    expect(result.resolved.userId).toBe(result.secondActor.userId);
    expect(result.resolved.ledgerId).toBe(result.secondActor.ledgerId);
  });
});
