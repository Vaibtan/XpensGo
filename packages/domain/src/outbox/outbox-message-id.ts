import { Schema } from "effect";

/** Identifier for a durable message waiting in the transactional outbox. */
export const OutboxMessageId = Schema.UUID.pipe(Schema.brand("OutboxMessageId"));

/** A durable transactional-outbox message identifier. */
export type OutboxMessageId = typeof OutboxMessageId.Type;
