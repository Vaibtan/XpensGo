import { Schema } from "effect";

/** Identifier for one durable transactional-outbox message. */
export const OutboxMessageId = Schema.UUID.pipe(Schema.brand("OutboxMessageId"));

/** A parsed durable transactional-outbox message identifier. */
export type OutboxMessageId = typeof OutboxMessageId.Type;
