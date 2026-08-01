import { Schema } from "effect";

/** Identifier for one historical Channel Identity link. */
export const ChannelIdentityId = Schema.UUID.pipe(Schema.brand("ChannelIdentityId"));

/** A parsed Channel Identity identifier. */
export type ChannelIdentityId = typeof ChannelIdentityId.Type;

/** Telegram-assigned user identifier accepted only after verified webhook ingress. */
export const TelegramExternalAccountId = Schema.String.pipe(
  Schema.pattern(/^[1-9][0-9]{0,19}$/),
  Schema.brand("TelegramExternalAccountId"),
);

/** A parsed Telegram user identifier. */
export type TelegramExternalAccountId = typeof TelegramExternalAccountId.Type;

/** One-use high-entropy capability presented through a Telegram link command. */
export const ChannelLinkChallengeToken = Schema.String.pipe(
  Schema.length(43),
  Schema.pattern(/^[A-Za-z0-9_-]+$/),
  Schema.brand("ChannelLinkChallengeToken"),
);

/** A parsed one-use link capability. */
export type ChannelLinkChallengeToken = typeof ChannelLinkChallengeToken.Type;

/** SHA-256 digest persisted instead of a raw link capability. */
export const ChannelLinkChallengeDigest = Schema.String.pipe(
  Schema.length(64),
  Schema.pattern(/^[0-9a-f]+$/),
  Schema.brand("ChannelLinkChallengeDigest"),
);

/** A parsed persisted challenge digest. */
export type ChannelLinkChallengeDigest = typeof ChannelLinkChallengeDigest.Type;

/** Milliseconds since the Unix epoch used at Identity persistence seams. */
export const EpochMillis = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  Schema.brand("EpochMillis"),
);

/** A parsed epoch-millisecond instant. */
export type EpochMillis = typeof EpochMillis.Type;

/** Active Telegram Channel Identity shown on the authenticated web surface. */
export interface TelegramIdentitySummary {
  /** Historical link identifier used for an explicit unlink flow. */
  readonly channelIdentityId: ChannelIdentityId;

  /** Epoch milliseconds when the active link was established. */
  readonly linkedAtMillis: EpochMillis;
}
