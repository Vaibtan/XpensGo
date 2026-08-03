import { ChannelLinkChallengeToken } from "@xpensego/domain/identity/channel-identity";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { TelegramBotUsername, telegramChallengeDeepLink } from "./deep-link.js";

describe("Telegram challenge deep link", () => {
  it("encodes a one-use challenge in Telegram's bot start parameter", () => {
    expect(
      telegramChallengeDeepLink({
        botUsername: Schema.decodeUnknownSync(TelegramBotUsername)("XpenseGoTestBot"),
        purpose: "link",
        token: Schema.decodeUnknownSync(ChannelLinkChallengeToken)("a".repeat(43)),
      }),
    ).toBe(`https://t.me/XpenseGoTestBot?start=link_${"a".repeat(43)}`);
  });
});
