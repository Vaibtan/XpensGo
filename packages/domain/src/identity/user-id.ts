import { Schema } from "effect";

/** Identifier for an Xpensego user. */
export const UserId = Schema.UUID.pipe(Schema.brand("UserId"));

/** An Xpensego user identifier. */
export type UserId = typeof UserId.Type;
