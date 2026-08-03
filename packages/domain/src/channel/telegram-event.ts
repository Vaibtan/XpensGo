import { type Redacted, Schema } from "effect";

import type {
  ChannelLinkChallengeToken,
  TelegramExternalAccountId,
} from "../identity/channel-identity.js";
import { ChannelLinkChallengeDigest } from "../identity/channel-identity.js";

/** Telegram update identifier used as the provider idempotency key. */
export const TelegramUpdateId = Schema.String.pipe(
  Schema.pattern(/^[0-9]{1,20}$/),
  Schema.brand("TelegramUpdateId"),
);

/** Telegram private-chat identifier retained only at the channel boundary. */
export const TelegramConversationId = Schema.String.pipe(
  Schema.pattern(/^-?[1-9][0-9]{0,19}$/),
  Schema.brand("TelegramConversationId"),
);

/** Telegram message identifier within one chat. */
export const TelegramMessageId = Schema.String.pipe(
  Schema.pattern(/^[1-9][0-9]{0,19}$/),
  Schema.brand("TelegramMessageId"),
);

/** Bounded text accepted from one private Telegram message. */
export const TelegramMessageText = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4_096),
  Schema.brand("TelegramMessageText"),
);

/** Parsed Telegram update identifier. */
export type TelegramUpdateId = typeof TelegramUpdateId.Type;

/** Parsed Telegram private-chat identifier. */
export type TelegramConversationId = typeof TelegramConversationId.Type;

/** Parsed Telegram message identifier. */
export type TelegramMessageId = typeof TelegramMessageId.Type;

/** Parsed bounded Telegram text. */
export type TelegramMessageText = typeof TelegramMessageText.Type;

/** Supported content from a verified Telegram update. */
export type VerifiedTelegramContent =
  | { readonly _tag: "Text"; readonly text: TelegramMessageText }
  | {
      readonly _tag: "LinkCommand";
      readonly token: Redacted.Redacted<ChannelLinkChallengeToken>;
    }
  | {
      readonly _tag: "UnlinkCommand";
      readonly token: Redacted.Redacted<ChannelLinkChallengeToken>;
    }
  | { readonly _tag: "InvalidCommand"; readonly command: "link" | "unlink" };

/** Provider-authenticated Telegram event before application persistence or identity resolution. */
export interface VerifiedTelegramUpdate {
  readonly updateId: TelegramUpdateId;
  readonly externalAccountId: TelegramExternalAccountId;
  readonly externalConversationId: TelegramConversationId;
  readonly externalMessageId: TelegramMessageId;
  readonly occurredAtMillis: number;
  readonly content: VerifiedTelegramContent;
}

/** Persistable Telegram content with raw one-use capabilities replaced by digests. */
export const PersistedTelegramContent = Schema.Union(
  Schema.TaggedStruct("Text", { text: TelegramMessageText }),
  Schema.TaggedStruct("LinkCommand", { challengeDigest: ChannelLinkChallengeDigest }),
  Schema.TaggedStruct("UnlinkCommand", { challengeDigest: ChannelLinkChallengeDigest }),
  Schema.TaggedStruct("InvalidCommand", { command: Schema.Literal("link", "unlink") }),
);

/** Versioned normalized Telegram event stored before asynchronous identity resolution. */
export const PersistedTelegramEventV1 = Schema.Struct({
  version: Schema.Literal(1),
  updateId: TelegramUpdateId,
  externalAccountId: Schema.String.pipe(
    Schema.pattern(/^[1-9][0-9]{0,19}$/),
    Schema.brand("TelegramExternalAccountId"),
  ),
  externalConversationId: TelegramConversationId,
  externalMessageId: TelegramMessageId,
  occurredAtMillis: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  content: PersistedTelegramContent,
});

/** Persisted Telegram content after secret minimization. */
export type PersistedTelegramContent = typeof PersistedTelegramContent.Type;

/** Parsed version 1 persisted Telegram event. */
export type PersistedTelegramEventV1 = typeof PersistedTelegramEventV1.Type;
