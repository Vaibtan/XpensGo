import { Schema } from "effect";

/** Stable identifier for a transaction Category. */
export const CategoryId = Schema.UUID.pipe(Schema.brand("CategoryId"));

/** A parsed Category identifier. */
export type CategoryId = typeof CategoryId.Type;

/** Stable machine-readable key for a default Category. */
export const CategoryKey = Schema.NonEmptyString.pipe(
  Schema.maxLength(64),
  Schema.pattern(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/),
  Schema.brand("CategoryKey"),
);

/** A parsed default Category key. */
export type CategoryKey = typeof CategoryKey.Type;

/** One seeded Category whose identifier and key never depend on its display label. */
export interface DefaultCategory {
  /** Stable database identifier. */
  readonly id: CategoryId;

  /** Stable application key. */
  readonly key: CategoryKey;

  /** User-facing label kept independent from the stable key. */
  readonly label: string;

  /** Whether classification uncertainty must remain visible through this Category. */
  readonly isFallback: boolean;
}

function category(
  sequence: number,
  key: string,
  label: string,
  isFallback = false,
): DefaultCategory {
  return {
    id: Schema.decodeUnknownSync(CategoryId)(
      `10000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    ),
    key: Schema.decodeUnknownSync(CategoryKey)(key),
    label,
    isFallback,
  };
}

/** Stable Indian-oriented Category taxonomy seeded before financial capture opens. */
export const DEFAULT_CATEGORIES: ReadonlyArray<DefaultCategory> = [
  category(1, "food_dining", "Food & Dining"),
  category(2, "groceries", "Groceries"),
  category(3, "transport", "Transport"),
  category(4, "housing", "Housing"),
  category(5, "utilities", "Utilities"),
  category(6, "shopping", "Shopping"),
  category(7, "healthcare", "Healthcare"),
  category(8, "education", "Education"),
  category(9, "entertainment", "Entertainment"),
  category(10, "travel", "Travel"),
  category(11, "personal_family", "Personal & Family"),
  category(12, "fees_taxes", "Fees & Taxes"),
  category(13, "transfers", "Transfers"),
  category(14, "cash_withdrawal", "Cash Withdrawal"),
  category(15, "income", "Income"),
  category(16, "refunds", "Refunds"),
  category(17, "other", "Other", true),
];
