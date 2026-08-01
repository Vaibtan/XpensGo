import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { CategoryId, DEFAULT_CATEGORIES } from "./default-categories.js";

describe("default categories", () => {
  it("keeps stable identifiers for the selected alpha taxonomy", () => {
    expect(DEFAULT_CATEGORIES.map(({ key }) => key)).toEqual([
      "food_dining",
      "groceries",
      "transport",
      "housing",
      "utilities",
      "shopping",
      "healthcare",
      "education",
      "entertainment",
      "travel",
      "personal_family",
      "fees_taxes",
      "transfers",
      "cash_withdrawal",
      "income",
      "refunds",
      "other",
    ]);
    expect(DEFAULT_CATEGORIES.every(({ id }) => Schema.is(CategoryId)(id))).toBe(true);
  });

  it("makes Other the sole visible fallback", () => {
    expect(DEFAULT_CATEGORIES.filter(({ isFallback }) => isFallback)).toEqual([
      expect.objectContaining({ key: "other", label: "Other" }),
    ]);
  });
});
