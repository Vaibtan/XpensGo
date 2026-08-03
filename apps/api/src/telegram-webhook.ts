import {
  TelegramConversationId,
  TelegramMessageId,
  TelegramMessageText,
  TelegramUpdateId,
  type VerifiedTelegramUpdate,
} from "@xpensego/domain/channel/telegram-event";
import {
  ChannelLinkChallengeToken,
  TelegramExternalAccountId,
} from "@xpensego/domain/identity/channel-identity";
import { Effect, Redacted, Schema } from "effect";

const TelegramProviderUpdate = Schema.Struct({
  update_id: Schema.Int.pipe(Schema.nonNegative()),
  message: Schema.optional(
    Schema.Struct({
      message_id: Schema.Int.pipe(Schema.positive()),
      date: Schema.Int.pipe(Schema.nonNegative()),
      chat: Schema.Struct({
        id: Schema.Int,
        type: Schema.String,
      }),
      from: Schema.optional(
        Schema.Struct({
          id: Schema.Int.pipe(Schema.positive()),
          is_bot: Schema.Boolean,
        }),
      ),
      text: Schema.optional(Schema.String),
    }),
  ),
});

/** Configuration required to authenticate and bound one Telegram webhook request. */
export interface TelegramWebhookConfig {
  readonly webhookSecret: Redacted.Redacted<string>;
  readonly maximumBodyBytes: number;
}

/** The Telegram webhook credential did not authenticate the request. */
export class TelegramWebhookUnauthorized extends Schema.TaggedError<TelegramWebhookUnauthorized>()(
  "TelegramWebhookUnauthorized",
  {},
) {
  /** Safe description that never includes supplied or configured secrets. */
  override get message(): string {
    return "The Telegram webhook credential is invalid";
  }
}

/** The Telegram request body exceeded the configured bounded buffer. */
export class TelegramWebhookBodyTooLarge extends Schema.TaggedError<TelegramWebhookBodyTooLarge>()(
  "TelegramWebhookBodyTooLarge",
  {},
) {
  /** Safe description that does not report message contents. */
  override get message(): string {
    return "The Telegram webhook body is too large";
  }
}

/** The authenticated Telegram update is outside the currently supported private-text subset. */
export class TelegramWebhookUnsupported extends Schema.TaggedError<TelegramWebhookUnsupported>()(
  "TelegramWebhookUnsupported",
  {
    reason: Schema.Literal("group_chat", "missing_sender", "bot_sender", "non_text", "update_type"),
  },
) {
  /** Safe description that excludes provider payload contents. */
  override get message(): string {
    return `The Telegram update is unsupported: ${this.reason}`;
  }
}

/** The authenticated Telegram body was not valid JSON or did not match the provider envelope. */
export class TelegramWebhookMalformed extends Schema.TaggedError<TelegramWebhookMalformed>()(
  "TelegramWebhookMalformed",
  {},
) {
  /** Safe description that excludes the rejected body. */
  override get message(): string {
    return "The Telegram webhook body is malformed";
  }
}

/** Web Crypto or request streaming was unavailable while verifying the webhook. */
export class TelegramWebhookUnavailable extends Schema.TaggedError<TelegramWebhookUnavailable>()(
  "TelegramWebhookUnavailable",
  { operation: Schema.Literal("verify_secret", "read_body") },
) {
  /** Safe infrastructure description. */
  override get message(): string {
    return "Telegram webhook verification is temporarily unavailable";
  }
}

type TelegramWebhookError =
  | TelegramWebhookBodyTooLarge
  | TelegramWebhookMalformed
  | TelegramWebhookUnauthorized
  | TelegramWebhookUnavailable
  | TelegramWebhookUnsupported;

function parseTelegramContent(text: typeof TelegramMessageText.Type) {
  const directCommand = /^\/(link|unlink)(?:@[A-Za-z0-9_]{5,32})?(?:\s+(\S+))?\s*$/.exec(text);
  const startCommand =
    directCommand === null
      ? /^\/start(?:@[A-Za-z0-9_]{5,32})?\s+(link|unlink)_(\S+)\s*$/.exec(text)
      : null;
  const commandMatch = directCommand ?? startCommand;
  if (commandMatch === null) {
    return { _tag: "Text", text } as const;
  }

  const command = commandMatch[1] === "link" ? "link" : "unlink";
  const tokenCandidate = commandMatch[2] ?? "";
  const token = Schema.decodeUnknownEither(ChannelLinkChallengeToken)(tokenCandidate);
  if (token._tag === "Left") {
    return { _tag: "InvalidCommand", command } as const;
  }

  return command === "link"
    ? ({ _tag: "LinkCommand", token: Redacted.make(token.right) } as const)
    : ({ _tag: "UnlinkCommand", token: Redacted.make(token.right) } as const);
}

async function timingSafeSecretMatch(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);

  // SAFETY: Wrangler's generated Worker runtime type and the retrieved 2026-08-01
  // @cloudflare/workers-types both declare timingSafeEqual. The cast only bridges
  // the Node test type's narrower SubtleCrypto declaration.
  const workerSubtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(left: BufferSource, right: BufferSource): boolean;
  };
  return workerSubtle.timingSafeEqual(providedDigest, expectedDigest);
}

async function readBoundedBody(
  request: Request,
  maximumBodyBytes: number,
): Promise<
  | { readonly _tag: "Body"; readonly value: string }
  | { readonly _tag: "Malformed" }
  | { readonly _tag: "TooLarge" }
> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > maximumBodyBytes) {
      return { _tag: "TooLarge" };
    }
  }

  if (request.body === null) {
    return { _tag: "Body", value: "" };
  }

  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let totalBytes = 0;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    totalBytes += chunk.value.byteLength;
    if (totalBytes > maximumBodyBytes) {
      await reader.cancel();
      return { _tag: "TooLarge" };
    }
    chunks.push(chunk.value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { _tag: "Body", value: new TextDecoder("utf-8", { fatal: true }).decode(body) };
  } catch {
    return { _tag: "Malformed" };
  }
}

/**
 * Authenticate and decode the bounded private-text subset of one Telegram webhook request.
 *
 * @param request - Untrusted request delivered to the Telegram webhook route.
 * @param config - Redacted credential and maximum buffered body size.
 * @returns A provider-authenticated, parsed Telegram update.
 */
export function verifyAndDecodeTelegramWebhook(
  request: Request,
  config: TelegramWebhookConfig,
): Effect.Effect<VerifiedTelegramUpdate, TelegramWebhookError> {
  return Effect.gen(function* () {
    const suppliedSecret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
    const secretMatches = yield* Effect.tryPromise({
      try: () => timingSafeSecretMatch(suppliedSecret, Redacted.value(config.webhookSecret)),
      catch: () => new TelegramWebhookUnavailable({ operation: "verify_secret" }),
    });
    if (!secretMatches) {
      return yield* new TelegramWebhookUnauthorized();
    }

    const boundedBody = yield* Effect.tryPromise({
      try: () => readBoundedBody(request, config.maximumBodyBytes),
      catch: () => new TelegramWebhookUnavailable({ operation: "read_body" }),
    });
    if (boundedBody._tag === "TooLarge") {
      return yield* new TelegramWebhookBodyTooLarge();
    }
    if (boundedBody._tag === "Malformed") {
      return yield* new TelegramWebhookMalformed();
    }

    const candidate = yield* Effect.try({
      try: () => {
        const parsed: unknown = JSON.parse(boundedBody.value);
        return parsed;
      },
      catch: () => new TelegramWebhookMalformed(),
    });
    const update = yield* Schema.decodeUnknown(TelegramProviderUpdate)(candidate, {
      onExcessProperty: "ignore",
    }).pipe(Effect.mapError(() => new TelegramWebhookMalformed()));
    if (update.message === undefined) {
      return yield* new TelegramWebhookUnsupported({ reason: "update_type" });
    }
    if (update.message.chat.type !== "private") {
      return yield* new TelegramWebhookUnsupported({ reason: "group_chat" });
    }
    if (update.message.from === undefined) {
      return yield* new TelegramWebhookUnsupported({ reason: "missing_sender" });
    }
    if (update.message.from.is_bot) {
      return yield* new TelegramWebhookUnsupported({ reason: "bot_sender" });
    }
    if (update.message.text === undefined) {
      return yield* new TelegramWebhookUnsupported({ reason: "non_text" });
    }

    const [updateId, externalAccountId, externalConversationId, externalMessageId, text] =
      yield* Effect.all([
        Schema.decodeUnknown(TelegramUpdateId)(String(update.update_id)),
        Schema.decodeUnknown(TelegramExternalAccountId)(String(update.message.from.id)),
        Schema.decodeUnknown(TelegramConversationId)(String(update.message.chat.id)),
        Schema.decodeUnknown(TelegramMessageId)(String(update.message.message_id)),
        Schema.decodeUnknown(TelegramMessageText)(update.message.text),
      ]).pipe(Effect.mapError(() => new TelegramWebhookMalformed()));

    return {
      updateId,
      externalAccountId,
      externalConversationId,
      externalMessageId,
      occurredAtMillis: update.message.date * 1_000,
      content: parseTelegramContent(text),
    } satisfies VerifiedTelegramUpdate;
  });
}
