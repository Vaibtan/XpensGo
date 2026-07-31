import { Schema } from "effect";

/** Identifier for an accepted inbound channel event. */
export const InboundEventId = Schema.UUID.pipe(Schema.brand("InboundEventId"));

/** Messaging channels understood by the application boundary. */
export const MessagingChannel = Schema.Literal("telegram", "whatsapp");

/** Provider-assigned identifier for one inbound channel delivery. */
export const ExternalChannelEventId = Schema.NonEmptyString.pipe(
  Schema.maxLength(256),
  Schema.brand("ExternalChannelEventId"),
);

/** An accepted inbound channel event identifier. */
export type InboundEventId = typeof InboundEventId.Type;

/** A supported messaging channel. */
export type MessagingChannel = typeof MessagingChannel.Type;

/** A parsed provider event identifier. */
export type ExternalChannelEventId = typeof ExternalChannelEventId.Type;
