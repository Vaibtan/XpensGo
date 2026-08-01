import { Schema } from "effect";

/** Authenticated User, personal Ledger, and active Telegram link state. */
export const IdentityOverviewV1 = Schema.Struct({
  version: Schema.Literal(1),
  user: Schema.Struct({
    id: Schema.UUID,
    email: Schema.String,
    name: Schema.String,
    timezone: Schema.String,
  }),
  ledger: Schema.Struct({ id: Schema.UUID }),
  telegramIdentities: Schema.Array(
    Schema.Struct({
      channelIdentityId: Schema.UUID,
      linkedAtMillis: Schema.Number,
    }),
  ),
});

/** A parsed Identity overview response. */
export type IdentityOverviewV1 = typeof IdentityOverviewV1.Type;

/** Request to change the authenticated User's IANA timezone. */
export const ChangeIdentityTimezoneV1 = Schema.Struct({
  timezone: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
});

/** Request to create an unlink challenge for an owned active identity. */
export const CreateTelegramUnlinkChallengeV1 = Schema.Struct({
  channelIdentityId: Schema.UUID,
});

/** One-use raw capability returned only to the authenticated web client. */
export const TelegramChallengeV1 = Schema.Struct({
  version: Schema.Literal(1),
  channel: Schema.Literal("telegram"),
  purpose: Schema.Literal("link", "unlink"),
  token: Schema.String.pipe(Schema.length(43), Schema.pattern(/^[A-Za-z0-9_-]+$/)),
  expiresAtMillis: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});

/** A parsed one-use Telegram challenge response. */
export type TelegramChallengeV1 = typeof TelegramChallengeV1.Type;
