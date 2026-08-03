import { Schema } from "effect";

/** Identifier for one durable outbound channel message. */
export const OutboundChannelMessageId = Schema.UUID.pipe(Schema.brand("OutboundChannelMessageId"));

/** Identifier for one provider delivery attempt. */
export const ChannelDeliveryAttemptId = Schema.UUID.pipe(Schema.brand("ChannelDeliveryAttemptId"));

/** A parsed outbound channel message identifier. */
export type OutboundChannelMessageId = typeof OutboundChannelMessageId.Type;

/** A parsed channel delivery-attempt identifier. */
export type ChannelDeliveryAttemptId = typeof ChannelDeliveryAttemptId.Type;

/** Stable semantic content understood by the Telegram renderer. */
export const TelegramReplyContent = Schema.Union(
  Schema.TaggedStruct("LinkSucceeded", {}),
  Schema.TaggedStruct("UnlinkSucceeded", {}),
  Schema.TaggedStruct("LinkRequired", {}),
  Schema.TaggedStruct("CaptureUnavailable", {}),
  Schema.TaggedStruct("ChallengeRejected", {
    purpose: Schema.Literal("link", "unlink"),
    reason: Schema.Literal(
      "already_linked",
      "already_used",
      "expired",
      "identity_mismatch",
      "invalid_command",
      "not_found",
    ),
  }),
);

/** A supported channel action rendered as a web deep link. */
export const OutboundChannelAction = Schema.TaggedStruct("OpenWeb", {
  path: Schema.Literal("/workspace"),
});

/** Versioned semantic reply intent persisted before provider delivery. */
export const TelegramReplyIntentV1 = Schema.Struct({
  version: Schema.Literal(1),
  channel: Schema.Literal("telegram"),
  purpose: Schema.Literal("reply", "system"),
  privacy: Schema.Literal("private"),
  content: TelegramReplyContent,
  actions: Schema.Array(OutboundChannelAction),
});

/** Parsed Telegram semantic reply content. */
export type TelegramReplyContent = typeof TelegramReplyContent.Type;

/** Parsed version 1 Telegram semantic reply intent. */
export type TelegramReplyIntentV1 = typeof TelegramReplyIntentV1.Type;
