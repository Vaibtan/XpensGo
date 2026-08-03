import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import { Effect, Layer, Ref, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  TelegramEventProcessingStore,
  TelegramProcessingClaimId,
  processTelegramEvent,
  type CompleteTelegramEventInput,
  type TelegramEventProcessingStoreService,
} from "./process-telegram-event.js";
import { OutboundChannelMessageId } from "./outbound-channel-intent.js";
import {
  PersistedTelegramEventV1,
  TelegramConversationId,
  TelegramMessageId,
  TelegramMessageText,
  TelegramUpdateId,
} from "./telegram-event.js";
import { InboundEventId } from "./inbound-event.js";
import {
  ChannelIdentityId,
  ChannelLinkChallengeDigest,
  TelegramExternalAccountId,
} from "../identity/channel-identity.js";
import {
  IdentityStore,
  TelegramIdentityNotLinked,
  type IdentityStoreService,
} from "../identity/identity.js";
import { UserId } from "../identity/user-id.js";
import { UserTimezone } from "../identity/user-timezone.js";
import { LedgerId } from "../ledger/ledger-id.js";

const ids = {
  correlationId: Schema.decodeUnknownSync(CorrelationId)("bfda0c22-5be5-44c0-9c27-85ea19be7121"),
  inboundEventId: Schema.decodeUnknownSync(InboundEventId)("7e104e94-a209-4627-8102-070e4d39bded"),
  outboxMessageId: Schema.decodeUnknownSync(OutboxMessageId)(
    "b65a580c-ac48-48b2-856d-d4b69494fa47",
  ),
  userId: Schema.decodeUnknownSync(UserId)("0a37f42e-a007-4d0d-adc2-98098f486ecc"),
  ledgerId: Schema.decodeUnknownSync(LedgerId)("34502fb7-d5c9-4a30-a480-54c66583240a"),
  channelIdentityId: Schema.decodeUnknownSync(ChannelIdentityId)(
    "d78b6a0d-4b48-4a8c-aa67-917226f54e55",
  ),
  claimId: Schema.decodeUnknownSync(TelegramProcessingClaimId)(
    "2eef8c16-8d16-4dd9-927a-7570e709020d",
  ),
  outboundMessageId: Schema.decodeUnknownSync(OutboundChannelMessageId)(
    "59ffc071-7af5-47f0-998b-80e54642acd8",
  ),
} as const;

const textEvent = Schema.decodeUnknownSync(PersistedTelegramEventV1)({
  version: 1,
  updateId: Schema.decodeUnknownSync(TelegramUpdateId)("8183"),
  externalAccountId: Schema.decodeUnknownSync(TelegramExternalAccountId)("123456"),
  externalConversationId: Schema.decodeUnknownSync(TelegramConversationId)("123456"),
  externalMessageId: Schema.decodeUnknownSync(TelegramMessageId)("101"),
  occurredAtMillis: 1_785_638_402_000,
  content: {
    _tag: "Text",
    text: Schema.decodeUnknownSync(TelegramMessageText)("Spent 250 on lunch"),
  },
});

const actor = {
  _tag: "ChannelActor",
  userId: ids.userId,
  ledgerId: ids.ledgerId,
  timezone: Schema.decodeUnknownSync(UserTimezone)("Asia/Kolkata"),
  correlationId: ids.correlationId,
  authenticationStrength: "linked_channel",
  channel: "telegram",
  channelIdentityId: ids.channelIdentityId,
} as const;

function identityLayer(
  resolveTelegramActor: IdentityStoreService["resolveTelegramActor"],
  overrides: Partial<IdentityStoreService> = {},
) {
  const unused = () => Effect.die("unexpected Identity operation");
  return Layer.succeed(
    IdentityStore,
    IdentityStore.of({
      resolveTelegramActor,
      resolveWebActor: unused,
      changeUserTimezone: unused,
      listTelegramIdentities: unused,
      createTelegramLinkChallenge: unused,
      consumeTelegramLinkChallenge: unused,
      createTelegramUnlinkChallenge: unused,
      consumeTelegramUnlinkChallenge: unused,
      ...overrides,
    }),
  );
}

describe("process Telegram event", () => {
  it("resolves linked authority server-side before persisting a normalized command and reply intent", async () => {
    const completion = await Effect.runPromise(
      Effect.gen(function* () {
        const captured = yield* Ref.make<CompleteTelegramEventInput | undefined>(undefined);
        const processingStore: TelegramEventProcessingStoreService = {
          claim: () =>
            Effect.succeed({
              _tag: "Claimed" as const,
              claimId: ids.claimId,
              inboundEventId: ids.inboundEventId,
              event: textEvent,
            }),
          complete: (input) =>
            Ref.set(captured, input).pipe(
              Effect.as({
                _tag: "Completed" as const,
                outboundMessageId: ids.outboundMessageId,
              }),
            ),
          enforceUserLimit: () => Effect.succeed({ _tag: "Allowed" as const }),
          release: () => Effect.void,
        };
        yield* processTelegramEvent({
          outboxMessageId: ids.outboxMessageId,
          correlationId: ids.correlationId,
        }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(
                TelegramEventProcessingStore,
                TelegramEventProcessingStore.of(processingStore),
              ),
              identityLayer(() => Effect.succeed(actor)),
            ),
          ),
        );
        return yield* Ref.get(captured);
      }),
    );

    expect(completion).toMatchObject({
      completion: {
        _tag: "LinkedTextAccepted",
        actor,
        text: "Spent 250 on lunch",
        intent: {
          content: { _tag: "CaptureUnavailable" },
          actions: [{ _tag: "OpenWeb", path: "/workspace" }],
        },
      },
    });
  });

  it("suppresses an abuse-limited event before resolving identity", async () => {
    const processingLayer = Layer.succeed(
      TelegramEventProcessingStore,
      TelegramEventProcessingStore.of({
        claim: () => Effect.succeed({ _tag: "RateLimited" as const }),
        complete: () => Effect.die("rate-limited events are already terminal"),
        enforceUserLimit: () => Effect.die("rate-limited events do not resolve a User"),
        release: () => Effect.die("rate-limited events do not hold a claim"),
      }),
    );
    const result = await Effect.runPromise(
      processTelegramEvent({
        outboxMessageId: ids.outboxMessageId,
        correlationId: ids.correlationId,
      }).pipe(
        Effect.provide(
          Layer.merge(
            processingLayer,
            identityLayer(() => Effect.die("identity resolution must not run")),
          ),
        ),
      ),
    );

    expect(result).toEqual({ _tag: "Suppressed", reason: "rate_limited" });
  });

  it("converges replay after link consumption on the active linked identity", async () => {
    const linkEvent = Schema.decodeUnknownSync(PersistedTelegramEventV1)({
      ...textEvent,
      content: {
        _tag: "LinkCommand",
        challengeDigest: Schema.decodeUnknownSync(ChannelLinkChallengeDigest)("a".repeat(64)),
      },
    });
    const completion = await Effect.runPromise(
      Effect.gen(function* () {
        const captured = yield* Ref.make<CompleteTelegramEventInput | undefined>(undefined);
        const processingStore: TelegramEventProcessingStoreService = {
          claim: () =>
            Effect.succeed({
              _tag: "Claimed" as const,
              claimId: ids.claimId,
              inboundEventId: ids.inboundEventId,
              event: linkEvent,
            }),
          complete: (input) =>
            Ref.set(captured, input).pipe(
              Effect.as({
                _tag: "Completed" as const,
                outboundMessageId: ids.outboundMessageId,
              }),
            ),
          enforceUserLimit: () => Effect.succeed({ _tag: "Allowed" as const }),
          release: () => Effect.void,
        };
        yield* processTelegramEvent({
          outboxMessageId: ids.outboxMessageId,
          correlationId: ids.correlationId,
        }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(
                TelegramEventProcessingStore,
                TelegramEventProcessingStore.of(processingStore),
              ),
              identityLayer(() => Effect.succeed(actor), {
                consumeTelegramLinkChallenge: () =>
                  Effect.succeed({ _tag: "ChallengeAlreadyConsumed" as const }),
              }),
            ),
          ),
        );
        return yield* Ref.get(captured);
      }),
    );

    expect(completion).toMatchObject({
      completion: {
        _tag: "ScopedReply",
        actor,
        intent: { content: { _tag: "LinkSucceeded" } },
      },
    });
  });

  it("converges replay after unlink consumption on successful unlink state", async () => {
    const unlinkEvent = Schema.decodeUnknownSync(PersistedTelegramEventV1)({
      ...textEvent,
      content: {
        _tag: "UnlinkCommand",
        challengeDigest: Schema.decodeUnknownSync(ChannelLinkChallengeDigest)("b".repeat(64)),
      },
    });
    const completion = await Effect.runPromise(
      Effect.gen(function* () {
        const captured = yield* Ref.make<CompleteTelegramEventInput | undefined>(undefined);
        const processingStore: TelegramEventProcessingStoreService = {
          claim: () =>
            Effect.succeed({
              _tag: "Claimed" as const,
              claimId: ids.claimId,
              inboundEventId: ids.inboundEventId,
              event: unlinkEvent,
            }),
          complete: (input) =>
            Ref.set(captured, input).pipe(
              Effect.as({
                _tag: "Completed" as const,
                outboundMessageId: ids.outboundMessageId,
              }),
            ),
          enforceUserLimit: () => Effect.die("the identity is already unlinked"),
          release: () => Effect.void,
        };
        yield* processTelegramEvent({
          outboxMessageId: ids.outboxMessageId,
          correlationId: ids.correlationId,
        }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(
                TelegramEventProcessingStore,
                TelegramEventProcessingStore.of(processingStore),
              ),
              identityLayer(() => Effect.fail(new TelegramIdentityNotLinked()), {
                consumeTelegramUnlinkChallenge: () =>
                  Effect.succeed({ _tag: "ChallengeAlreadyConsumed" as const }),
              }),
            ),
          ),
        );
        return yield* Ref.get(captured);
      }),
    );

    expect(completion).toMatchObject({
      completion: {
        _tag: "UnscopedReply",
        intent: { content: { _tag: "UnlinkSucceeded" } },
      },
    });
  });
});
