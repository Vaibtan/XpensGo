import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_USER_TIMEZONE, UserTimezone } from "./user-timezone.js";

describe("UserTimezone", () => {
  it("normalizes a supported IANA timezone", () => {
    expect(Schema.decodeUnknownSync(UserTimezone)("  Asia/Kolkata  ")).toBe("Asia/Kolkata");
  });

  it("accepts the documented onboarding default", () => {
    expect(Schema.is(UserTimezone)(DEFAULT_USER_TIMEZONE)).toBe(true);
  });

  it("rejects an unknown timezone", () => {
    expect(Schema.decodeUnknownEither(UserTimezone)("Asia/Not-A-Place")._tag).toBe("Left");
  });
});
