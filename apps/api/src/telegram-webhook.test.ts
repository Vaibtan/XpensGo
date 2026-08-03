import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import {
  TelegramWebhookBodyTooLarge,
  TelegramWebhookUnauthorized,
  TelegramWebhookUnsupported,
  verifyAndDecodeTelegramWebhook,
} from "./telegram-webhook.js";

const webhookSecret = Redacted.make("telegram-webhook-secret-for-tests");

function telegramRequest(body: BodyInit, secret = Redacted.value(webhookSecret)): Request {
  return new Request("https://api.example.test/v1/channels/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body,
  });
}

describe("Telegram webhook adapter", () => {
  it("decodes a private text update while tolerating additive provider fields", async () => {
    const result = await Effect.runPromise(
      verifyAndDecodeTelegramWebhook(
        telegramRequest(
          JSON.stringify({
            update_id: 8181,
            future_field: { additive: true },
            message: {
              message_id: 99,
              date: 1_785_638_400,
              future_message_field: "ignored",
              chat: { id: 123_456, type: "private", first_name: "Private" },
              from: { id: 123_456, is_bot: false, first_name: "Person" },
              text: "Spent 250 on lunch",
            },
          }),
        ),
        { webhookSecret, maximumBodyBytes: 4_096 },
      ),
    );

    expect(result).toEqual({
      updateId: "8181",
      externalAccountId: "123456",
      externalConversationId: "123456",
      externalMessageId: "99",
      occurredAtMillis: 1_785_638_400_000,
      content: { _tag: "Text", text: "Spent 250 on lunch" },
    });
  });

  it("parses a one-use link command as redacted capability material", async () => {
    const token = "a".repeat(43);
    const result = await Effect.runPromise(
      verifyAndDecodeTelegramWebhook(
        telegramRequest(
          JSON.stringify({
            update_id: 8183,
            message: {
              message_id: 101,
              date: 1_785_638_402,
              chat: { id: 123_456, type: "private" },
              from: { id: 123_456, is_bot: false },
              text: `/link@XpenseGoBot ${token}`,
            },
          }),
        ),
        { webhookSecret, maximumBodyBytes: 4_096 },
      ),
    );

    expect(result.content._tag).toBe("LinkCommand");
    if (result.content._tag === "LinkCommand") {
      expect(Redacted.value(result.content.token)).toBe(token);
    }
  });

  it("decodes a Telegram start deep link into the same one-use link command", async () => {
    const token = "b".repeat(43);
    const result = await Effect.runPromise(
      verifyAndDecodeTelegramWebhook(
        telegramRequest(
          JSON.stringify({
            update_id: 8189,
            message: {
              message_id: 109,
              date: 1_785_638_409,
              chat: { id: 123_456, type: "private" },
              from: { id: 123_456, is_bot: false },
              text: `/start link_${token}`,
            },
          }),
        ),
        { webhookSecret, maximumBodyBytes: 4_096 },
      ),
    );

    expect(result.content._tag).toBe("LinkCommand");
    if (result.content._tag === "LinkCommand") {
      expect(Redacted.value(result.content.token)).toBe(token);
    }
  });

  it("does not retain malformed challenge material in normalized command state", async () => {
    const result = await Effect.runPromise(
      verifyAndDecodeTelegramWebhook(
        telegramRequest(
          JSON.stringify({
            update_id: 8184,
            message: {
              message_id: 102,
              date: 1_785_638_403,
              chat: { id: 123_456, type: "private" },
              from: { id: 123_456, is_bot: false },
              text: "/unlink definitely-not-a-valid-token",
            },
          }),
        ),
        { webhookSecret, maximumBodyBytes: 4_096 },
      ),
    );

    expect(result.content).toEqual({ _tag: "InvalidCommand", command: "unlink" });
  });

  it("rejects a mismatched secret without exposing either value", async () => {
    const result = await Effect.runPromise(
      verifyAndDecodeTelegramWebhook(telegramRequest("{}", "wrong-secret"), {
        webhookSecret,
        maximumBodyBytes: 4_096,
      }).pipe(Effect.either),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(TelegramWebhookUnauthorized);
    }
  });

  it("classifies group-chat operations as permanently unsupported", async () => {
    const result = await Effect.runPromise(
      verifyAndDecodeTelegramWebhook(
        telegramRequest(
          JSON.stringify({
            update_id: 8182,
            message: {
              message_id: 100,
              date: 1_785_638_401,
              chat: { id: -100_123_456, type: "supergroup" },
              from: { id: 123_456, is_bot: false },
              text: "show my ledger",
            },
          }),
        ),
        { webhookSecret, maximumBodyBytes: 4_096 },
      ).pipe(Effect.either),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "TelegramWebhookUnsupported",
        reason: "group_chat",
      } satisfies Partial<TelegramWebhookUnsupported>);
    }
  });

  it("stops reading after the configured body limit", async () => {
    const result = await Effect.runPromise(
      verifyAndDecodeTelegramWebhook(
        telegramRequest(JSON.stringify({ padding: "x".repeat(512) })),
        {
          webhookSecret,
          maximumBodyBytes: 128,
        },
      ).pipe(Effect.either),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(TelegramWebhookBodyTooLarge);
    }
  });

  it("classifies invalid UTF-8 as malformed input instead of infrastructure failure", async () => {
    const result = await Effect.runPromise(
      verifyAndDecodeTelegramWebhook(telegramRequest(new Uint8Array([0xc3, 0x28]).buffer), {
        webhookSecret,
        maximumBodyBytes: 4_096,
      }).pipe(Effect.either),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("TelegramWebhookMalformed");
    }
  });
});
