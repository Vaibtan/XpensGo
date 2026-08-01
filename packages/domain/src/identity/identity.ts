import type { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { Clock, Context, Effect, Redacted, Schema } from "effect";

import type { AuthUserId, ChannelActorContext, WebActorContext } from "./actor-context.js";
import {
  ChannelLinkChallengeDigest,
  type ChannelLinkChallengeToken,
  type ChannelIdentityId,
  EpochMillis,
  type TelegramExternalAccountId,
  type TelegramIdentitySummary,
} from "./channel-identity.js";
import type { UserTimezone } from "./user-timezone.js";

const challengeLifetimeMillis = 10 * 60 * 1_000;
const challengeRateLimitWindowMillis = 60 * 60 * 1_000;
const maximumChallengesPerWindow = 5;

/** Expected infrastructure failure while resolving application-owned identity authority. */
export class IdentityPersistenceUnavailable extends Schema.TaggedError<IdentityPersistenceUnavailable>()(
  "IdentityPersistenceUnavailable",
  {
    operation: Schema.Literal(
      "resolveWebActor",
      "changeUserTimezone",
      "listTelegramIdentities",
      "createTelegramLinkChallenge",
      "consumeTelegramLinkChallenge",
      "createTelegramUnlinkChallenge",
      "consumeTelegramUnlinkChallenge",
      "resolveTelegramActor",
    ),
    reason: Schema.Literal("database_unavailable"),
  },
) {
  /** Safe description that omits database details and user data. */
  override get message(): string {
    return "Identity persistence is unavailable";
  }
}

/** Expected rejection when a stale or mismatched ActorContext no longer owns its Ledger. */
export class IdentityAuthorityNotFound extends Schema.TaggedError<IdentityAuthorityNotFound>()(
  "IdentityAuthorityNotFound",
  {
    operation: Schema.Literal(
      "changeUserTimezone",
      "createTelegramLinkChallenge",
      "createTelegramUnlinkChallenge",
    ),
  },
) {
  /** Safe description that does not reveal whether a User or Ledger exists. */
  override get message(): string {
    return "The authenticated identity authority is no longer available";
  }
}

/** Expected rejection after a User exceeds the bounded challenge-creation policy. */
export class ChannelLinkChallengeRateLimited extends Schema.TaggedError<ChannelLinkChallengeRateLimited>()(
  "ChannelLinkChallengeRateLimited",
  {
    retryAfterSeconds: Schema.Int.pipe(Schema.positive()),
  },
) {
  /** Safe description that omits challenge material. */
  override get message(): string {
    return "Telegram link challenge creation is temporarily rate limited";
  }
}

/** Expected rejection when no stored challenge matches the presented capability. */
export class ChannelLinkChallengeNotFound extends Schema.TaggedError<ChannelLinkChallengeNotFound>()(
  "ChannelLinkChallengeNotFound",
  {},
) {
  /** Safe description that does not reveal challenge history. */
  override get message(): string {
    return "The Telegram link challenge is not available";
  }
}

/** Expected rejection when a challenge is presented after its short lifetime. */
export class ChannelLinkChallengeExpired extends Schema.TaggedError<ChannelLinkChallengeExpired>()(
  "ChannelLinkChallengeExpired",
  {},
) {
  /** Safe description that does not expose challenge material. */
  override get message(): string {
    return "The Telegram link challenge has expired";
  }
}

/** Expected rejection when a consumed challenge is presented again. */
export class ChannelLinkChallengeAlreadyConsumed extends Schema.TaggedError<ChannelLinkChallengeAlreadyConsumed>()(
  "ChannelLinkChallengeAlreadyConsumed",
  {},
) {
  /** Safe description that does not expose challenge material. */
  override get message(): string {
    return "The Telegram link challenge has already been used";
  }
}

/** Expected rejection when an active Telegram identity belongs to another User. */
export class TelegramIdentityAlreadyLinked extends Schema.TaggedError<TelegramIdentityAlreadyLinked>()(
  "TelegramIdentityAlreadyLinked",
  {},
) {
  /** Safe description that does not identify the current owner. */
  override get message(): string {
    return "The Telegram identity is already linked";
  }
}

/** Expected rejection when no active Telegram identity can establish authority. */
export class TelegramIdentityNotLinked extends Schema.TaggedError<TelegramIdentityNotLinked>()(
  "TelegramIdentityNotLinked",
  {},
) {
  /** Safe description that does not reveal historical links. */
  override get message(): string {
    return "The Telegram identity is not linked";
  }
}

/** Expected rejection when the requested active identity is outside the web actor's authority. */
export class ChannelIdentityNotFound extends Schema.TaggedError<ChannelIdentityNotFound>()(
  "ChannelIdentityNotFound",
  {},
) {
  /** Safe description that does not reveal another User's link state. */
  override get message(): string {
    return "The Telegram identity is not available";
  }
}

/** Expected rejection when an unlink challenge is presented by a different Telegram identity. */
export class TelegramIdentityDoesNotMatchChallenge extends Schema.TaggedError<TelegramIdentityDoesNotMatchChallenge>()(
  "TelegramIdentityDoesNotMatchChallenge",
  {},
) {
  /** Safe description that does not disclose the target identity. */
  override get message(): string {
    return "The Telegram identity does not match this challenge";
  }
}

/** Expected failure while generating or hashing one-use challenge material. */
export class LinkChallengeCryptoUnavailable extends Schema.TaggedError<LinkChallengeCryptoUnavailable>()(
  "LinkChallengeCryptoUnavailable",
  {
    operation: Schema.Literal("generateToken", "digestToken"),
  },
) {
  /** Safe description that omits challenge material and provider details. */
  override get message(): string {
    return "Telegram link challenge cryptography is unavailable";
  }
}

/** Input required to resolve one verified provider principal. */
export interface ResolveWebActorInput {
  /** Better Auth user identifier obtained from a verified session. */
  readonly authUserId: AuthUserId;

  /** Correlation identifier propagated by the entrypoint. */
  readonly correlationId: CorrelationId;
}

/** Input required to change the timezone owned by one trusted web actor. */
export interface ChangeUserTimezoneInput {
  /** Trusted server-constructed authority for the mutation. */
  readonly actor: WebActorContext;

  /** Parsed replacement IANA timezone. */
  readonly timezone: UserTimezone;
}

/** Input required to read web-visible Identity state. */
export interface ReadIdentityOverviewInput {
  /** Trusted server-constructed authority for the read. */
  readonly actor: WebActorContext;
}

/** Application result shown on the authenticated Identity surface. */
export interface IdentityOverview {
  /** Trusted User and Ledger authority for the current request. */
  readonly actor: WebActorContext;

  /** Active Telegram identities linked to the User. */
  readonly telegramIdentities: ReadonlyArray<TelegramIdentitySummary>;
}

/** Application input for creating a web-authorized Telegram link challenge. */
export interface CreateTelegramLinkChallengeInput {
  /** Trusted web authority that will own a successful link. */
  readonly actor: WebActorContext;
}

/** Application input for creating an explicit web-authorized Telegram unlink challenge. */
export interface CreateTelegramUnlinkChallengeInput {
  /** Trusted web authority that owns the active link. */
  readonly actor: WebActorContext;

  /** Historical identity identifier selected on the authenticated web surface. */
  readonly channelIdentityId: ChannelIdentityId;
}

/** One-use Telegram link capability returned only to its authenticated creator. */
export interface TelegramLinkChallenge {
  /** Redacted raw capability that is never persisted or logged. */
  readonly token: Redacted.Redacted<ChannelLinkChallengeToken>;

  /** Epoch milliseconds after which the capability is terminal. */
  readonly expiresAtMillis: EpochMillis;
}

/** Application input accepted only after verified Telegram webhook ingress. */
export interface ConsumeTelegramLinkChallengeInput {
  /** One-use capability parsed from the supported Telegram command. */
  readonly token: Redacted.Redacted<ChannelLinkChallengeToken>;

  /** Verified Telegram user identifier supplied by the channel adapter. */
  readonly externalAccountId: TelegramExternalAccountId;

  /** Correlation identifier propagated from channel ingress. */
  readonly correlationId: CorrelationId;
}

/** Successful first link of a Telegram identity. */
export interface TelegramIdentityLinked {
  readonly _tag: "TelegramIdentityLinked";
  readonly channelIdentityId: ChannelIdentityId;
  readonly actor: ChannelActorContext;
}

/** Successful removal of one active Telegram identity link. */
export interface TelegramIdentityUnlinked {
  readonly _tag: "TelegramIdentityUnlinked";
  readonly channelIdentityId: ChannelIdentityId;
}

/** Input required to resolve an already-linked Telegram identity. */
export interface ResolveTelegramActorInput {
  /** Verified Telegram user identifier supplied by the channel adapter. */
  readonly externalAccountId: TelegramExternalAccountId;

  /** Correlation identifier propagated from channel ingress. */
  readonly correlationId: CorrelationId;
}

/** Persistence command for one hashed, bounded link challenge. */
export interface PersistTelegramLinkChallengeInput {
  readonly actor: WebActorContext;
  readonly tokenDigest: ChannelLinkChallengeDigest;
  readonly createdAtMillis: EpochMillis;
  readonly expiresAtMillis: EpochMillis;
  readonly rateLimitSinceMillis: EpochMillis;
  readonly maximumChallenges: number;
}

/** Persistence command for one hashed, bounded unlink challenge. */
export interface PersistTelegramUnlinkChallengeInput extends PersistTelegramLinkChallengeInput {
  readonly channelIdentityId: ChannelIdentityId;
}

/** Persistence result when a new challenge is accepted. */
export interface TelegramLinkChallengeStored {
  readonly _tag: "Stored";
}

/** Persistence result when challenge creation is rejected by policy. */
export interface TelegramLinkChallengeStoreRateLimited {
  readonly _tag: "RateLimited";
  readonly retryAfterSeconds: number;
}

/** Observable persistence result for challenge creation. */
export type PersistTelegramLinkChallengeOutcome =
  TelegramLinkChallengeStored | TelegramLinkChallengeStoreRateLimited;

/** Persistence command for atomically consuming a hashed link challenge. */
export interface ConsumeTelegramLinkChallengeStoreInput {
  readonly tokenDigest: ChannelLinkChallengeDigest;
  readonly externalAccountId: TelegramExternalAccountId;
  readonly correlationId: CorrelationId;
  readonly consumedAtMillis: EpochMillis;
}

/** Persistence command for atomically consuming a hashed unlink challenge. */
export type ConsumeTelegramUnlinkChallengeStoreInput = ConsumeTelegramLinkChallengeStoreInput;

/** Committed persistence outcome for one challenge presentation. */
export type ConsumeTelegramLinkChallengeStoreOutcome =
  | TelegramIdentityLinked
  | { readonly _tag: "ChallengeNotFound" }
  | { readonly _tag: "ChallengeExpired" }
  | { readonly _tag: "ChallengeAlreadyConsumed" }
  | { readonly _tag: "TelegramIdentityAlreadyLinked" };

/** Committed persistence outcome for one unlink challenge presentation. */
export type ConsumeTelegramUnlinkChallengeStoreOutcome =
  | TelegramIdentityUnlinked
  | { readonly _tag: "ChallengeNotFound" }
  | { readonly _tag: "ChallengeExpired" }
  | { readonly _tag: "ChallengeAlreadyConsumed" }
  | { readonly _tag: "TelegramIdentityDoesNotMatchChallenge" }
  | { readonly _tag: "ChannelIdentityNotFound" };

/** Cryptographic authority required to issue and persist one-use capabilities safely. */
export interface LinkChallengeCryptoService {
  /** Generate one high-entropy capability. */
  readonly generateToken: Effect.Effect<
    Redacted.Redacted<ChannelLinkChallengeToken>,
    LinkChallengeCryptoUnavailable
  >;

  /** Produce the stable digest persisted in place of a raw capability. */
  readonly digestToken: (
    token: Redacted.Redacted<ChannelLinkChallengeToken>,
  ) => Effect.Effect<ChannelLinkChallengeDigest, LinkChallengeCryptoUnavailable>;
}

/** Authority seam for secure Telegram link challenge material. */
export class LinkChallengeCrypto extends Context.Tag(
  "@xpensego/domain/identity/LinkChallengeCrypto",
)<LinkChallengeCrypto, LinkChallengeCryptoService>() {}

/** Application-owned persistence capability required by Identity operations. */
export interface IdentityStoreService {
  /** Resolve or atomically provision the User and personal Ledger for a verified principal. */
  readonly resolveWebActor: (
    input: ResolveWebActorInput,
  ) => Effect.Effect<WebActorContext, IdentityPersistenceUnavailable>;

  /** Change a User timezone only while its User-to-Ledger authority still holds. */
  readonly changeUserTimezone: (
    input: ChangeUserTimezoneInput,
  ) => Effect.Effect<WebActorContext, IdentityAuthorityNotFound | IdentityPersistenceUnavailable>;

  /** List active Telegram identities without exposing provider identifiers. */
  readonly listTelegramIdentities: (
    input: ReadIdentityOverviewInput,
  ) => Effect.Effect<ReadonlyArray<TelegramIdentitySummary>, IdentityPersistenceUnavailable>;

  /** Persist one hashed link challenge under the User's rate limit. */
  readonly createTelegramLinkChallenge: (
    input: PersistTelegramLinkChallengeInput,
  ) => Effect.Effect<
    PersistTelegramLinkChallengeOutcome,
    IdentityAuthorityNotFound | IdentityPersistenceUnavailable
  >;

  /** Atomically consume one challenge and establish at most one active identity. */
  readonly consumeTelegramLinkChallenge: (
    input: ConsumeTelegramLinkChallengeStoreInput,
  ) => Effect.Effect<ConsumeTelegramLinkChallengeStoreOutcome, IdentityPersistenceUnavailable>;

  /** Persist one hashed unlink challenge for an active identity owned by the web actor. */
  readonly createTelegramUnlinkChallenge: (
    input: PersistTelegramUnlinkChallengeInput,
  ) => Effect.Effect<
    PersistTelegramLinkChallengeOutcome,
    ChannelIdentityNotFound | IdentityAuthorityNotFound | IdentityPersistenceUnavailable
  >;

  /** Atomically consume one unlink challenge without accepting client-owned identity scope. */
  readonly consumeTelegramUnlinkChallenge: (
    input: ConsumeTelegramUnlinkChallengeStoreInput,
  ) => Effect.Effect<ConsumeTelegramUnlinkChallengeStoreOutcome, IdentityPersistenceUnavailable>;

  /** Resolve one verified Telegram user identifier into trusted authority. */
  readonly resolveTelegramActor: (
    input: ResolveTelegramActorInput,
  ) => Effect.Effect<
    ChannelActorContext,
    IdentityPersistenceUnavailable | TelegramIdentityNotLinked
  >;
}

/** Authority seam for application-owned User, Ledger, and channel-identity persistence. */
export class IdentityStore extends Context.Tag("@xpensego/domain/identity/IdentityStore")<
  IdentityStore,
  IdentityStoreService
>() {}

/**
 * Resolve one verified web principal into server-owned User and Ledger authority.
 *
 * @param input - Verified provider identifier and request correlation metadata.
 * @returns A trusted ActorContext, provisioning the personal Ledger when first observed.
 */
export const resolveWebActor = Effect.fn("Identity.resolveWebActor")(function* (
  input: ResolveWebActorInput,
) {
  const store = yield* IdentityStore;
  return yield* store.resolveWebActor(input);
});

/**
 * Change the timezone for one trusted web actor without accepting client-owned scope.
 *
 * @param input - Trusted ActorContext and parsed replacement timezone.
 * @returns The refreshed ActorContext with the new timezone.
 */
export const changeUserTimezone = Effect.fn("Identity.changeUserTimezone")(function* (
  input: ChangeUserTimezoneInput,
) {
  const store = yield* IdentityStore;
  return yield* store.changeUserTimezone(input);
});

/** Read active channel-link state for one trusted web actor. */
export const readIdentityOverview = Effect.fn("Identity.readOverview")(function* (
  input: ReadIdentityOverviewInput,
) {
  const store = yield* IdentityStore;
  const telegramIdentities = yield* store.listTelegramIdentities(input);
  return { actor: input.actor, telegramIdentities } satisfies IdentityOverview;
});

/** Create one high-entropy, hashed, short-lived Telegram link challenge. */
export const createTelegramLinkChallenge = Effect.fn("Identity.createTelegramLinkChallenge")(
  function* (input: CreateTelegramLinkChallengeInput) {
    const crypto = yield* LinkChallengeCrypto;
    const store = yield* IdentityStore;
    const token = yield* crypto.generateToken;
    const tokenDigest = yield* crypto.digestToken(token);
    const now = EpochMillis.make(yield* Clock.currentTimeMillis);
    const expiresAtMillis = EpochMillis.make(now + challengeLifetimeMillis);
    const outcome = yield* store.createTelegramLinkChallenge({
      actor: input.actor,
      tokenDigest,
      createdAtMillis: now,
      expiresAtMillis,
      rateLimitSinceMillis: EpochMillis.make(Math.max(0, now - challengeRateLimitWindowMillis)),
      maximumChallenges: maximumChallengesPerWindow,
    });

    if (outcome._tag === "RateLimited") {
      return yield* new ChannelLinkChallengeRateLimited({
        retryAfterSeconds: outcome.retryAfterSeconds,
      });
    }

    return { token, expiresAtMillis } satisfies TelegramLinkChallenge;
  },
);

/** Consume one verified Telegram link command without trusting client-owned User scope. */
export const consumeTelegramLinkChallenge = Effect.fn("Identity.consumeTelegramLinkChallenge")(
  function* (input: ConsumeTelegramLinkChallengeInput) {
    const crypto = yield* LinkChallengeCrypto;
    const store = yield* IdentityStore;
    const tokenDigest = yield* crypto.digestToken(input.token);
    const outcome = yield* store.consumeTelegramLinkChallenge({
      tokenDigest,
      externalAccountId: input.externalAccountId,
      correlationId: input.correlationId,
      consumedAtMillis: EpochMillis.make(yield* Clock.currentTimeMillis),
    });

    switch (outcome._tag) {
      case "TelegramIdentityLinked":
        return outcome;
      case "ChallengeNotFound":
        return yield* new ChannelLinkChallengeNotFound();
      case "ChallengeExpired":
        return yield* new ChannelLinkChallengeExpired();
      case "ChallengeAlreadyConsumed":
        return yield* new ChannelLinkChallengeAlreadyConsumed();
      case "TelegramIdentityAlreadyLinked":
        return yield* new TelegramIdentityAlreadyLinked();
    }
  },
);

/** Create one short-lived unlink capability for an active identity owned by the web actor. */
export const createTelegramUnlinkChallenge = Effect.fn("Identity.createTelegramUnlinkChallenge")(
  function* (input: CreateTelegramUnlinkChallengeInput) {
    const crypto = yield* LinkChallengeCrypto;
    const store = yield* IdentityStore;
    const token = yield* crypto.generateToken;
    const tokenDigest = yield* crypto.digestToken(token);
    const now = EpochMillis.make(yield* Clock.currentTimeMillis);
    const expiresAtMillis = EpochMillis.make(now + challengeLifetimeMillis);
    const outcome = yield* store.createTelegramUnlinkChallenge({
      actor: input.actor,
      channelIdentityId: input.channelIdentityId,
      tokenDigest,
      createdAtMillis: now,
      expiresAtMillis,
      rateLimitSinceMillis: EpochMillis.make(Math.max(0, now - challengeRateLimitWindowMillis)),
      maximumChallenges: maximumChallengesPerWindow,
    });

    if (outcome._tag === "RateLimited") {
      return yield* new ChannelLinkChallengeRateLimited({
        retryAfterSeconds: outcome.retryAfterSeconds,
      });
    }

    return { token, expiresAtMillis } satisfies TelegramLinkChallenge;
  },
);

/** Consume one verified Telegram unlink command and retain its historical link record. */
export const consumeTelegramUnlinkChallenge = Effect.fn("Identity.consumeTelegramUnlinkChallenge")(
  function* (input: ConsumeTelegramLinkChallengeInput) {
    const crypto = yield* LinkChallengeCrypto;
    const store = yield* IdentityStore;
    const tokenDigest = yield* crypto.digestToken(input.token);
    const outcome = yield* store.consumeTelegramUnlinkChallenge({
      tokenDigest,
      externalAccountId: input.externalAccountId,
      correlationId: input.correlationId,
      consumedAtMillis: EpochMillis.make(yield* Clock.currentTimeMillis),
    });

    switch (outcome._tag) {
      case "TelegramIdentityUnlinked":
        return outcome;
      case "ChallengeNotFound":
        return yield* new ChannelLinkChallengeNotFound();
      case "ChallengeExpired":
        return yield* new ChannelLinkChallengeExpired();
      case "ChallengeAlreadyConsumed":
        return yield* new ChannelLinkChallengeAlreadyConsumed();
      case "TelegramIdentityDoesNotMatchChallenge":
        return yield* new TelegramIdentityDoesNotMatchChallenge();
      case "ChannelIdentityNotFound":
        return yield* new ChannelIdentityNotFound();
    }
  },
);

/** Resolve one verified Telegram identity through application-owned link state. */
export const resolveTelegramActor = Effect.fn("Identity.resolveTelegramActor")(function* (
  input: ResolveTelegramActorInput,
) {
  const store = yield* IdentityStore;
  return yield* store.resolveTelegramActor(input);
});
