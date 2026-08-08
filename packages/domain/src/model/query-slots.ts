import { Schema } from "effect";

const OptionalDate = Schema.NullOr(Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/)));
const OptionalFilter = Schema.NullOr(
  Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
);

/** Bounded query intent and slots; it contains no ledger scope, rows, or executable SQL. */
export const QuerySlotsSuggestion = Schema.Struct({
  category: OptionalFilter,
  counterparty: OptionalFilter,
  direction: Schema.Literal("debit", "credit", "all"),
  fromOn: OptionalDate,
  grouping: Schema.Literal("none", "day", "week", "month", "category", "counterparty"),
  metric: Schema.Literal("spending", "income", "net_movement", "transactions"),
  requiresClarification: Schema.Boolean,
  toOn: OptionalDate,
});

/** A decoded supported-query suggestion awaiting deterministic authorization. */
export type QuerySlotsSuggestion = typeof QuerySlotsSuggestion.Type;
