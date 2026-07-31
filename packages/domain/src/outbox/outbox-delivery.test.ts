import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import { Effect, Layer, Ref, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  OutboxClaimId,
  OutboxPublicationAttempt,
  OutboxPersistence,
  OutboxPublication,
  OutboxPublicationUnavailable,
  dispatchPendingOutbox,
  recordOutboxConsumption,
  type ClaimedOutboxPublication,
  type OutboxConsumptionOutcome,
} from "./outbox-delivery.js";
import { RuntimeTelemetry, type RuntimeTelemetryEvent } from "../platform/runtime-telemetry.js";

const firstPublication: ClaimedOutboxPublication = {
  outboxMessageId: Schema.decodeUnknownSync(OutboxMessageId)(
    "98b2ea19-c24e-49a3-a808-f39667b3c32e",
  ),
  claimId: Schema.decodeUnknownSync(OutboxClaimId)("68e1bb86-b539-45ac-ac65-0a6a9187105e"),
  correlationId: Schema.decodeUnknownSync(CorrelationId)("0a07b859-8572-4f11-bc54-36ee65c96ac5"),
  attempt: Schema.decodeUnknownSync(OutboxPublicationAttempt)(1),
};

const secondPublication: ClaimedOutboxPublication = {
  outboxMessageId: Schema.decodeUnknownSync(OutboxMessageId)(
    "9f7f01f4-74d4-4a87-86b4-6880114d22b1",
  ),
  claimId: Schema.decodeUnknownSync(OutboxClaimId)("b7d804ba-fe60-418e-833b-a0491757b878"),
  correlationId: Schema.decodeUnknownSync(CorrelationId)("153aa2c8-072c-4ce9-a7d4-b1c0ac4ad2a2"),
  attempt: Schema.decodeUnknownSync(OutboxPublicationAttempt)(2),
};

function makeTestProgram(options: {
  readonly claimed: ReadonlyArray<ClaimedOutboxPublication>;
  readonly consumptionOutcome?: OutboxConsumptionOutcome;
  readonly failPublicationFor?: OutboxMessageId;
}) {
  return Effect.gen(function* () {
    const published = yield* Ref.make<ReadonlyArray<OutboxMessageId>>([]);
    const marked = yield* Ref.make<ReadonlyArray<OutboxMessageId>>([]);
    const deferred = yield* Ref.make<ReadonlyArray<OutboxMessageId>>([]);
    const failed = yield* Ref.make<ReadonlyArray<OutboxMessageId>>([]);
    const telemetry = yield* Ref.make<ReadonlyArray<RuntimeTelemetryEvent>>([]);

    const dependencies = Layer.mergeAll(
      Layer.succeed(
        OutboxPersistence,
        OutboxPersistence.of({
          claimPending: () => Effect.succeed(options.claimed),
          markPublished: ({ outboxMessageId }) =>
            Ref.update(marked, (current) => [...current, outboxMessageId]),
          recordPublicationFailure: ({ outboxMessageId, disposition }) =>
            Ref.update(disposition === "terminal" ? failed : deferred, (current) => [
              ...current,
              outboxMessageId,
            ]),
          recordConsumption: () =>
            Effect.succeed(options.consumptionOutcome ?? { _tag: "Processed" }),
        }),
      ),
      Layer.succeed(
        OutboxPublication,
        OutboxPublication.of({
          publish: (input) =>
            options.failPublicationFor === input.outboxMessageId
              ? Effect.fail(
                  new OutboxPublicationUnavailable({
                    operation: "publishOutboxMessage",
                    outboxMessageId: input.outboxMessageId,
                    reason: "queue_request_failed",
                  }),
                )
              : Ref.update(published, (current) => [...current, input.outboxMessageId]),
        }),
      ),
      Layer.succeed(
        RuntimeTelemetry,
        RuntimeTelemetry.of({
          emit: (event) => Ref.update(telemetry, (current) => [...current, event]),
        }),
      ),
    );

    const summary = yield* dispatchPendingOutbox().pipe(Effect.provide(dependencies));

    return {
      summary,
      published: yield* Ref.get(published),
      marked: yield* Ref.get(marked),
      deferred: yield* Ref.get(deferred),
      failed: yield* Ref.get(failed),
      telemetry: yield* Ref.get(telemetry),
      dependencies,
    };
  });
}

describe("outbox delivery", () => {
  it("marks publication only after the Queue accepts the message", async () => {
    const result = await Effect.runPromise(
      makeTestProgram({ claimed: [firstPublication, secondPublication] }),
    );

    expect(result.summary).toEqual({ claimed: 2, published: 2, deferred: 0, failed: 0 });
    expect(result.published).toEqual([
      firstPublication.outboxMessageId,
      secondPublication.outboxMessageId,
    ]);
    expect(result.marked).toEqual(result.published);
    expect(result.deferred).toEqual([]);
  });

  it("terminalizes a publication that exhausts its bounded attempt policy", async () => {
    const exhaustedPublication = {
      ...firstPublication,
      attempt: Schema.decodeUnknownSync(OutboxPublicationAttempt)(5),
    } satisfies ClaimedOutboxPublication;
    const result = await Effect.runPromise(
      makeTestProgram({
        claimed: [exhaustedPublication],
        failPublicationFor: exhaustedPublication.outboxMessageId,
      }),
    );

    expect(result.summary).toEqual({ claimed: 1, published: 0, deferred: 0, failed: 1 });
    expect(result.deferred).toEqual([]);
    expect(result.failed).toEqual([exhaustedPublication.outboxMessageId]);
    expect(result.telemetry.map((event) => event.outcome)).toEqual(["failed"]);
  });

  it("records a retryable publication failure and continues the claimed batch", async () => {
    const result = await Effect.runPromise(
      makeTestProgram({
        claimed: [firstPublication, secondPublication],
        failPublicationFor: firstPublication.outboxMessageId,
      }),
    );

    expect(result.summary).toEqual({ claimed: 2, published: 1, deferred: 1, failed: 0 });
    expect(result.published).toEqual([secondPublication.outboxMessageId]);
    expect(result.marked).toEqual([secondPublication.outboxMessageId]);
    expect(result.deferred).toEqual([firstPublication.outboxMessageId]);
    expect(result.telemetry.map((event) => event.outcome).toSorted()).toEqual([
      "deferred",
      "published",
    ]);
  });

  it("returns the persistence-owned duplicate consumption outcome", async () => {
    const setup = await Effect.runPromise(
      makeTestProgram({
        claimed: [],
        consumptionOutcome: { _tag: "Duplicate" },
      }),
    );
    const outcome = await Effect.runPromise(
      recordOutboxConsumption({
        outboxMessageId: firstPublication.outboxMessageId,
        correlationId: firstPublication.correlationId,
      }).pipe(Effect.provide(setup.dependencies)),
    );

    expect(outcome).toEqual({ _tag: "Duplicate" });
  });
});
