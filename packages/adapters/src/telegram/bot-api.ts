import {
  TelegramBotApi,
  TelegramProviderOutcomeUnknown,
  TelegramProviderTerminalFailure,
  TelegramProviderTransientFailure,
  type TelegramBotApiService,
} from "@xpensego/domain/channel/deliver-telegram-reply";
import type { TelegramReplyIntentV1 } from "@xpensego/domain/channel/outbound-channel-intent";
import type { TelegramConversationId } from "@xpensego/domain/channel/telegram-event";
import { Effect, Layer, Redacted, Schema } from "effect";

const TelegramBotToken = Schema.String.pipe(
  Schema.pattern(/^[1-9][0-9]{4,15}:[A-Za-z0-9_-]{20,128}$/),
);
const TelegramSendSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({ message_id: Schema.Int }),
});
const TelegramSendFailure = Schema.Struct({
  ok: Schema.Literal(false),
  error_code: Schema.Int,
});

/** Provider configuration with an injectable fetch boundary for deterministic tests. */
export interface TelegramBotApiConfig {
  readonly botToken: Redacted.Redacted<string>;
  readonly publicWebOrigin: string;
  /**
   * Deliberate Worker Fetch boundary override for deterministic provider-contract tests.
   * Production omits it and uses the request-local Workers runtime implementation.
   */
  readonly fetch?: typeof globalThis.fetch;
}

type TelegramProviderConfiguration =
  | {
      readonly _tag: "Available";
      readonly botToken: Redacted.Redacted<string>;
      readonly publicWebOrigin: URL;
    }
  | { readonly _tag: "Unavailable" };

function validateConfiguration(config: TelegramBotApiConfig): TelegramProviderConfiguration {
  const token = Schema.decodeUnknownEither(TelegramBotToken)(Redacted.value(config.botToken));
  if (token._tag === "Left") {
    return { _tag: "Unavailable" };
  }
  try {
    const publicWebOrigin = new URL(config.publicWebOrigin);
    if (!["http:", "https:"].includes(publicWebOrigin.protocol)) {
      return { _tag: "Unavailable" };
    }
    return {
      _tag: "Available",
      botToken: Redacted.make(token.right),
      publicWebOrigin,
    };
  } catch {
    return { _tag: "Unavailable" };
  }
}

function renderContent(intent: TelegramReplyIntentV1): string {
  switch (intent.content._tag) {
    case "LinkSucceeded":
      return "Telegram is connected to XpensGo. You can now send expenses here.";
    case "UnlinkSucceeded":
      return "Telegram has been disconnected from your XpensGo account.";
    case "LinkRequired":
      return "Connect Telegram from your XpensGo workspace before sending expenses.";
    case "CaptureUnavailable":
      return "Your message was received, but expense capture is not available yet.";
    case "ChallengeRejected": {
      const purpose = intent.content.purpose === "link" ? "connection" : "disconnection";
      const reason =
        intent.content.reason === "expired"
          ? "expired"
          : intent.content.reason === "already_used"
            ? "was already used"
            : intent.content.reason === "already_linked"
              ? "belongs to an account that is already connected"
              : intent.content.reason === "identity_mismatch"
                ? "does not match this Telegram account"
                : intent.content.reason === "invalid_command"
                  ? "is not valid"
                  : "could not be found";
      return `That ${purpose} code ${reason}. Create a new code in your XpensGo workspace.`;
    }
  }
}

/** Render a semantic intent into the bounded Telegram sendMessage request body. */
function renderTelegramReply(
  externalConversationId: TelegramConversationId,
  intent: TelegramReplyIntentV1,
  publicWebOrigin: URL,
) {
  const workspaceUrl = new URL("/workspace", publicWebOrigin).toString();
  return {
    chat_id: externalConversationId,
    text: renderContent(intent),
    protect_content: true,
    link_preview_options: { is_disabled: true },
    ...(intent.actions.some((action) => action._tag === "OpenWeb")
      ? {
          reply_markup: {
            inline_keyboard: [[{ text: "Open XpensGo", url: workspaceUrl }]],
          },
        }
      : {}),
  } as const;
}

function statusErrorCode(status: number): string {
  return `telegram_http_${status}`;
}

/** Construct the Telegram Bot API service without exposing the bot token to logs or errors. */
export function makeTelegramBotApi(config: TelegramBotApiConfig): TelegramBotApiService {
  const fetchImplementation = config.fetch ?? globalThis.fetch;
  const configuration = validateConfiguration(config);

  const ensureAvailable: TelegramBotApiService["ensureAvailable"] = Effect.fn(
    "TelegramBotApi.ensureAvailable",
  )(function* () {
    if (configuration._tag === "Unavailable") {
      return yield* new TelegramProviderTransientFailure({
        errorCode: "provider_configuration_unavailable",
      });
    }
  });

  const send: TelegramBotApiService["send"] = Effect.fn("TelegramBotApi.send")(function* (input) {
    if (configuration._tag === "Unavailable") {
      return yield* new TelegramProviderTransientFailure({
        errorCode: "provider_configuration_unavailable",
      });
    }
    const body = renderTelegramReply(
      input.externalConversationId,
      input.intent,
      configuration.publicWebOrigin,
    );

    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImplementation(
          `https://api.telegram.org/bot${Redacted.value(configuration.botToken)}/sendMessage`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5_000),
          },
        ),
      catch: () => new TelegramProviderOutcomeUnknown({ errorCode: "network_outcome_unknown" }),
    });

    if (response.status === 429 || response.status >= 500) {
      return yield* new TelegramProviderTransientFailure({
        errorCode: statusErrorCode(response.status),
      });
    }
    if (!response.ok) {
      return yield* new TelegramProviderTerminalFailure({
        errorCode: statusErrorCode(response.status),
      });
    }

    const payload = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new TelegramProviderOutcomeUnknown({ errorCode: "invalid_provider_response" }),
    });
    const success = Schema.decodeUnknownEither(TelegramSendSuccess)(payload);
    if (success._tag === "Right") {
      return { providerMessageId: String(success.right.result.message_id) };
    }
    const failure = Schema.decodeUnknownEither(TelegramSendFailure)(payload);
    if (failure._tag === "Right") {
      return yield* failure.right.error_code === 429 || failure.right.error_code >= 500
        ? new TelegramProviderTransientFailure({
            errorCode: statusErrorCode(failure.right.error_code),
          })
        : new TelegramProviderTerminalFailure({
            errorCode: statusErrorCode(failure.right.error_code),
          });
    }
    return yield* new TelegramProviderOutcomeUnknown({
      errorCode: "invalid_provider_response",
    });
  });

  return TelegramBotApi.of({ ensureAvailable, send });
}

/** Telegram Bot API Layer. */
export function makeTelegramBotApiLayer(config: TelegramBotApiConfig) {
  return Layer.succeed(TelegramBotApi, makeTelegramBotApi(config));
}
