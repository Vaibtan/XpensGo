import {
  TelegramProviderOutcomeUnknown,
  TelegramProviderTerminalFailure,
  TelegramProviderTransientFailure,
} from "@xpensego/domain/channel/deliver-telegram-reply";
import { TelegramConversationId } from "@xpensego/domain/channel/telegram-event";
import { Effect, Redacted, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeTelegramBotApi } from "./bot-api.js";

const conversationId = Schema.decodeUnknownSync(TelegramConversationId)("123456");
const intent = {
  version: 1,
  channel: "telegram",
  purpose: "system",
  privacy: "private",
  content: { _tag: "LinkSucceeded" },
  actions: [{ _tag: "OpenWeb", path: "/workspace" }],
} as const;
const botToken = Redacted.make("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd");

function provider(fetchImplementation: typeof globalThis.fetch) {
  return makeTelegramBotApi({
    botToken,
    publicWebOrigin: "https://staging.xpensego.app",
    fetch: fetchImplementation,
  });
}

describe("Telegram Bot API adapter", () => {
  it("returns the provider message id after explicit acceptance", async () => {
    const fetchImplementation = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ ok: true, result: { message_id: 811 } }));

    await expect(
      Effect.runPromise(
        provider(fetchImplementation).send({
          externalConversationId: conversationId,
          intent,
        }),
      ),
    ).resolves.toEqual({ providerMessageId: "811" });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation.mock.calls[0]?.[0]).toContain("/sendMessage");
    const request = fetchImplementation.mock.calls[0]?.[1];
    expect(typeof request?.body).toBe("string");
    if (typeof request?.body !== "string") {
      return;
    }
    expect(JSON.parse(request.body)).toEqual({
      chat_id: "123456",
      text: "Telegram is connected to XpensGo. You can now send expenses here.",
      protect_content: true,
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [{ text: "Open XpensGo", url: "https://staging.xpensego.app/workspace" }],
        ],
      },
    });
  });

  it("classifies explicit rate limiting and server rejection as transient", async () => {
    const fetchImplementation = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 429 }));
    const error = await Effect.runPromise(
      provider(fetchImplementation)
        .send({ externalConversationId: conversationId, intent })
        .pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(TelegramProviderTransientFailure);
    expect(error.errorCode).toBe("telegram_http_429");
  });

  it("classifies explicit client rejection as terminal", async () => {
    const fetchImplementation = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 400 }));
    const error = await Effect.runPromise(
      provider(fetchImplementation)
        .send({ externalConversationId: conversationId, intent })
        .pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(TelegramProviderTerminalFailure);
    expect(error.errorCode).toBe("telegram_http_400");
  });

  it("classifies network rejection and invalid acceptance payloads as outcome unknown", async () => {
    const rejectedFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError("connection closed"));
    const invalidFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ ok: true, result: {} }));

    const networkError = await Effect.runPromise(
      provider(rejectedFetch)
        .send({ externalConversationId: conversationId, intent })
        .pipe(Effect.flip),
    );
    const invalidResponseError = await Effect.runPromise(
      provider(invalidFetch)
        .send({ externalConversationId: conversationId, intent })
        .pipe(Effect.flip),
    );

    expect(networkError).toBeInstanceOf(TelegramProviderOutcomeUnknown);
    expect(networkError.errorCode).toBe("network_outcome_unknown");
    expect(invalidResponseError).toBeInstanceOf(TelegramProviderOutcomeUnknown);
    expect(invalidResponseError.errorCode).toBe("invalid_provider_response");
  });
});
