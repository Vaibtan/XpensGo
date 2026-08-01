import { Schema } from "effect";

/** Provider-session subset consumed by the web boundary; additive provider fields are tolerated. */
export const BetterAuthWebSession = Schema.Struct({
  user: Schema.Struct({
    id: Schema.UUID,
    email: Schema.String,
    name: Schema.String,
  }),
});

/** Validated Better Auth session data needed by the current web shell. */
export type BetterAuthWebSession = typeof BetterAuthWebSession.Type;
