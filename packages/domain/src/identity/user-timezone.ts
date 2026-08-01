import { Schema } from "effect";

function isSupportedIanaTimezone(candidate: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** A normalized IANA timezone supported by the current runtime. */
export const UserTimezone = Schema.Trim.pipe(
  Schema.minLength(1),
  Schema.maxLength(64),
  Schema.filter(isSupportedIanaTimezone, {
    message: () => "Expected a supported IANA timezone",
  }),
  Schema.brand("UserTimezone"),
);

/** A parsed user timezone. */
export type UserTimezone = typeof UserTimezone.Type;

/** Default timezone used when an Indian alpha user has not selected one. */
export const DEFAULT_USER_TIMEZONE = Schema.decodeUnknownSync(UserTimezone)("Asia/Kolkata");
