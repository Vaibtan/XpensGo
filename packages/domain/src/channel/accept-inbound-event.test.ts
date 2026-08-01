import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { Effect, Layer, Ref, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  InboundEventStore,
  acceptInboundEvent,
  type PersistInboundEventInput,
} from "./accept-inbound-event.js";
import { ExternalChannelEventId } from "./inbound-event.js";
import { UserId } from "../identity/user-id.js";
import { LedgerId } from "../ledger/ledger-id.js";

describe("accept inbound event", () => {
  it("scopes its application idempotency key by operation and authenticated owner", async () => {
    const input = {
      ownerUserId: Schema.decodeUnknownSync(UserId)("0a37f42e-a007-4d0d-adc2-98098f486ecc"),
      ledgerId: Schema.decodeUnknownSync(LedgerId)("34502fb7-d5c9-4a30-a480-54c66583240a"),
      channel: "telegram" as const,
      externalEventId: Schema.decodeUnknownSync(ExternalChannelEventId)("telegram-update-1"),
      correlationId: Schema.decodeUnknownSync(CorrelationId)(
        "0a07b859-8572-4f11-bc54-36ee65c96ac5",
      ),
    };
    const persisted = await Effect.runPromise(
      Effect.gen(function* () {
        const captured = yield* Ref.make<PersistInboundEventInput | undefined>(undefined);
        const layer = Layer.succeed(
          InboundEventStore,
          InboundEventStore.of({
            persist: (command) =>
              Ref.set(captured, command).pipe(Effect.as({ _tag: "Duplicate" } as const)),
          }),
        );

        yield* acceptInboundEvent(input).pipe(Effect.provide(layer));
        return yield* Ref.get(captured);
      }),
    );

    expect(persisted?.idempotencyKey).toBe(
      `acceptInboundEvent:${input.ownerUserId}:telegram:telegram-update-1`,
    );
  });
});
