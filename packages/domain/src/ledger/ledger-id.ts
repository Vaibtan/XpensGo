import { Schema } from "effect";

/** Identifier for an Xpensego Ledger. */
export const LedgerId = Schema.UUID.pipe(Schema.brand("LedgerId"));

/** An Xpensego Ledger identifier. */
export type LedgerId = typeof LedgerId.Type;
