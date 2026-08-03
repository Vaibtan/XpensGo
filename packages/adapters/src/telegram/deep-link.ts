import type { ChannelLinkChallengeToken } from "@xpensego/domain/identity/channel-identity";
import { Schema } from "effect";

/** Public Telegram bot username used only to construct authenticated-web onboarding links. */
export const TelegramBotUsername = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z][A-Za-z0-9_]{4,31}$/),
  Schema.brand("TelegramBotUsername"),
);

/** A parsed Telegram bot username. */
export type TelegramBotUsername = typeof TelegramBotUsername.Type;

/** Construct Telegram's supported bot start link without weakening the one-use challenge. */
export function telegramChallengeDeepLink(input: {
  readonly botUsername: TelegramBotUsername;
  readonly purpose: "link" | "unlink";
  readonly token: ChannelLinkChallengeToken;
}): string {
  const url = new URL(`https://t.me/${input.botUsername}`);
  url.searchParams.set("start", `${input.purpose}_${input.token}`);
  return url.toString();
}
