import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env,
  getQueueResult,
} from "cloudflare:test";
import { PgClient } from "@effect/sql-pg";
import { makePostgresInboundEventStoreLayer } from "@xpensego/adapters/postgres/inbound-event-store";
import { makeIsolatedTestDatabase } from "@xpensego/adapters/postgres/isolated-test-database";
import { runMigrations } from "@xpensego/adapters/postgres/migrations";
import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { OutboxJobV1 } from "@xpensego/contracts/platform/outbox-job";
import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import { acceptInboundEvent } from "@xpensego/domain/channel/accept-inbound-event";
import { ExternalChannelEventId } from "@xpensego/domain/channel/inbound-event";
import { UserId } from "@xpensego/domain/identity/user-id";
import { LedgerId } from "@xpensego/domain/ledger/ledger-id";
import { platformFixtureIds } from "@xpensego/testing/platform/platform-fixtures";
import { Effect, Redacted, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import worker from "./index.js";

const testDatabase = makeIsolatedTestDatabase("xpensego_worker_outbox_integration");
const migrationClientLayer = PgClient.layer({
  url: testDatabase.migrationUrl,
  applicationName: "xpensego-worker-outbox-fixtures",
  maxConnections: 1,
});

const fixtureIds = {
  ownerUserId: Schema.decodeUnknownSync(UserId)("0a37f42e-a007-4d0d-adc2-98098f486ecc"),
  ledgerId: Schema.decodeUnknownSync(LedgerId)("34502fb7-d5c9-4a30-a480-54c66583240a"),
  otherOwnerUserId: Schema.decodeUnknownSync(UserId)("8ed91076-bdf7-4406-8579-d8031dca3267"),
  otherLedgerId: Schema.decodeUnknownSync(LedgerId)("3219a7f7-499c-416b-8097-63b5f144ac84"),
  correlationId: "0a07b859-8572-4f11-bc54-36ee65c96ac5",
  externalEventId: Schema.decodeUnknownSync(ExternalChannelEventId)("telegram-update-1"),
} as const;

const OutboxState = Schema.Struct({
  status: Schema.Literal("pending", "published", "failed"),
  publishAttempts: Schema.Int.pipe(Schema.nonNegative()),
  receiptCount: Schema.Int.pipe(Schema.nonNegative()),
  deliveryAttempts: Schema.Int.pipe(Schema.nonNegative()),
  lastPublishErrorCode: Schema.NullOr(Schema.String),
});

const AcceptanceProbeResult = Schema.Struct({
  version: Schema.Literal(1),
  operation: Schema.Literal("acceptInboundEvent"),
  buildRevision: Schema.Literal("0123456789abcdef0123456789abcdef01234567"),
  concurrentOutcomes: Schema.Array(Schema.Literal("Accepted", "Duplicate")),
  acceptedOutboxMessageId: OutboxMessageId,
  crossOwnerOutcome: Schema.Literal("InboundEventOwnershipMismatch"),
  redeliveryToken: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
});

class RecordingQueue implements Queue<unknown> {
  readonly messages: Array<unknown> = [];

  constructor(private failuresRemaining = 0) {}

  metrics(): Promise<QueueMetrics> {
    return Promise.resolve({ backlogCount: this.messages.length, backlogBytes: 0 });
  }

  send(message: unknown, _options?: QueueSendOptions): Promise<QueueSendResponse> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return Promise.reject(new Error("simulated Queue publication failure"));
    }

    this.messages.push(message);
    return Promise.resolve({
      metadata: { metrics: { backlogCount: this.messages.length, backlogBytes: 0 } },
    });
  }

  async sendBatch(
    messages: Iterable<MessageSendRequest<unknown>>,
    options?: QueueSendBatchOptions,
  ): Promise<QueueSendBatchResponse> {
    for (const message of messages) {
      const delaySeconds = message.delaySeconds ?? options?.delaySeconds;
      await this.send(message.body, delaySeconds === undefined ? undefined : { delaySeconds });
    }

    return {
      metadata: { metrics: { backlogCount: this.messages.length, backlogBytes: 0 } },
    };
  }
}

function makeIntegrationEnv(queue: Queue<unknown>): CloudflareBindings & {
  readonly BETTER_AUTH_SECRET: string;
  readonly BUILD_REVISION: string;
  readonly PHASE1_PROBE_SECRET: string;
  readonly PHASE1_PROBE_SIGNING_SECRET: string;
} {
  return {
    ...env,
    BETTER_AUTH_SECRET: "integration-test-secret-that-is-at-least-32-characters",
    BUILD_REVISION: "0123456789abcdef0123456789abcdef01234567",
    PHASE1_PROBE_SECRET: "phase1-probe-secret-that-is-at-least-32-characters",
    PHASE1_PROBE_SIGNING_SECRET: "phase1-probe-signing-secret-that-is-at-least-32-characters",
    HYPERDRIVE: {
      ...env.HYPERDRIVE,
      connectionString: Redacted.value(testDatabase.runtimeUrl),
    },
    PLATFORM_JOBS_QUEUE: queue,
  };
}

function makeWorkerRequest(url: string, init?: RequestInit): Parameters<typeof worker.fetch>[0] {
  // SAFETY: the Workers test pool constructs the same runtime Request but exposes a wider cf generic.
  return new Request(url, init) as Parameters<typeof worker.fetch>[0];
}

const seedAuthority = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  yield* sql`
    INSERT INTO users (id)
    VALUES (${fixtureIds.ownerUserId}), (${fixtureIds.otherOwnerUserId})
  `;
  yield* sql`
    INSERT INTO ledgers (id, owner_user_id)
    VALUES
      (${fixtureIds.ledgerId}, ${fixtureIds.ownerUserId}),
      (${fixtureIds.otherLedgerId}, ${fixtureIds.otherOwnerUserId})
  `;
}).pipe(Effect.provide(migrationClientLayer), Effect.scoped);

function acceptFixtureEvent() {
  return Effect.runPromise(
    acceptInboundEvent({
      ownerUserId: fixtureIds.ownerUserId,
      ledgerId: fixtureIds.ledgerId,
      channel: "telegram",
      externalEventId: fixtureIds.externalEventId,
      correlationId: Schema.decodeUnknownSync(CorrelationId)(fixtureIds.correlationId),
    }).pipe(
      Effect.provide(makePostgresInboundEventStoreLayer(testDatabase.runtimeUrl)),
      Effect.scoped,
    ),
  );
}

function readOutboxState(outboxMessageId: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{
        readonly status: unknown;
        readonly publishAttempts: unknown;
        readonly receiptCount: unknown;
        readonly deliveryAttempts: unknown;
        readonly lastPublishErrorCode: unknown;
      }>`
        SELECT
          message.status,
          message.publish_attempts AS "publishAttempts",
          message.last_publish_error_code AS "lastPublishErrorCode",
          COUNT(receipt.outbox_message_id)::integer AS "receiptCount",
          COALESCE(MAX(receipt.delivery_attempts), 0)::integer AS "deliveryAttempts"
        FROM outbox_messages AS message
        LEFT JOIN outbox_message_receipts AS receipt
          ON receipt.outbox_message_id = message.id
        WHERE message.id = ${outboxMessageId}
        GROUP BY message.id
      `;
      return yield* Schema.decodeUnknown(OutboxState)(rows[0]);
    }).pipe(Effect.provide(migrationClientLayer), Effect.scoped),
  );
}

async function runScheduled(queue: Queue<unknown>): Promise<void> {
  const context = createExecutionContext();
  await worker.scheduled(createScheduledController(), makeIntegrationEnv(queue), context);
}

beforeEach(async () => {
  await Effect.runPromise(testDatabase.recreate);
  await Effect.runPromise(runMigrations(testDatabase.migrationUrl));
  await Effect.runPromise(seedAuthority);
});

afterEach(async () => {
  await Effect.runPromise(testDatabase.drop);
});

describe("API Worker outbox integration", () => {
  it("drives concurrent acceptance and recoverable Queue delivery through the staging probe", async () => {
    const queue = new RecordingQueue();
    const probeEnv = {
      ...makeIntegrationEnv(queue),
      ENVIRONMENT: "staging" as const,
    };
    const authorization = `Bearer ${probeEnv.PHASE1_PROBE_SECRET}`;
    const probeUrl = `${probeEnv.PUBLIC_WEB_ORIGIN}/_internal/phase1-staging-proof`;
    const callProbe = (body: unknown) =>
      worker.fetch(
        makeWorkerRequest(probeUrl, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        probeEnv,
        createExecutionContext(),
      );

    const acceptanceResponse = await callProbe({
      operation: "acceptInboundEvent",
      runId: "integration-run",
      ownerUserId: fixtureIds.ownerUserId,
      ledgerId: fixtureIds.ledgerId,
      otherOwnerUserId: fixtureIds.otherOwnerUserId,
    });
    const acceptance = Schema.decodeUnknownSync(AcceptanceProbeResult)(
      await acceptanceResponse.json(),
    );

    expect(acceptanceResponse.status).toBe(200);
    expect(acceptance.concurrentOutcomes).toEqual(["Accepted", "Duplicate"]);
    expect(acceptance.crossOwnerOutcome).toBe("InboundEventOwnershipMismatch");

    const tamperedCapabilityResponse = await callProbe({
      operation: "redeliverOutbox",
      runId: "integration-run",
      outboxMessageId: "bdc02069-e8a1-4e88-863b-8f04e1c2a115",
      redeliveryToken: acceptance.redeliveryToken,
    });
    expect(tamperedCapabilityResponse.status).toBe(400);
    expect(queue.messages).toHaveLength(0);

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          UPDATE outbox_messages
          SET
            publish_attempts = 1,
            last_publish_error_code = 'queue_unavailable',
            next_publish_attempt_at = CURRENT_TIMESTAMP
          WHERE id = ${acceptance.acceptedOutboxMessageId}
        `;
      }).pipe(Effect.provide(migrationClientLayer), Effect.scoped),
    );

    await runScheduled(queue);
    expect(queue.messages).toHaveLength(1);

    const firstDelivery = createMessageBatch("xpensego-platform-jobs-staging", [
      {
        id: "phase1-proof-delivery-1",
        timestamp: new Date("2026-08-01T00:00:00.000Z"),
        attempts: 1,
        body: queue.messages[0],
      },
    ]);
    const firstDeliveryContext = createExecutionContext();
    await worker.queue(firstDelivery, probeEnv, firstDeliveryContext);
    const firstDeliveryResult = await getQueueResult(firstDelivery, firstDeliveryContext);

    expect(firstDeliveryResult.ackAll).toBe(false);
    expect(firstDeliveryResult.explicitAcks).toEqual(["phase1-proof-delivery-1"]);
    expect(await readOutboxState(acceptance.acceptedOutboxMessageId)).toEqual({
      status: "published",
      publishAttempts: 2,
      receiptCount: 1,
      deliveryAttempts: 1,
      lastPublishErrorCode: null,
    });

    const redeliveryResponse = await callProbe({
      operation: "redeliverOutbox",
      runId: "integration-run",
      outboxMessageId: acceptance.acceptedOutboxMessageId,
      redeliveryToken: acceptance.redeliveryToken,
    });
    expect(redeliveryResponse.status).toBe(200);
    expect(queue.messages).toHaveLength(2);

    const secondDelivery = createMessageBatch("xpensego-platform-jobs-staging", [
      {
        id: "phase1-proof-delivery-2",
        timestamp: new Date("2026-08-01T00:00:30.000Z"),
        attempts: 2,
        body: queue.messages[1],
      },
    ]);
    const secondDeliveryContext = createExecutionContext();
    await worker.queue(secondDelivery, probeEnv, secondDeliveryContext);
    const secondDeliveryResult = await getQueueResult(secondDelivery, secondDeliveryContext);

    expect(secondDeliveryResult.explicitAcks).toEqual(["phase1-proof-delivery-2"]);
    expect(await readOutboxState(acceptance.acceptedOutboxMessageId)).toMatchObject({
      receiptCount: 1,
      deliveryAttempts: 2,
    });
  });

  it("creates and resolves a Better Auth session through the Worker boundary", async () => {
    const integrationEnv = makeIntegrationEnv(new RecordingQueue());
    const origin = integrationEnv.PUBLIC_WEB_ORIGIN;
    const signUpResponse = await worker.fetch(
      makeWorkerRequest(`${origin}/v1/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
        },
        body: JSON.stringify({
          email: "alpha-one@example.test",
          name: "Alpha One",
          password: "correct-horse-battery-staple",
        }),
      }),
      integrationEnv,
      createExecutionContext(),
    );

    expect(signUpResponse.status).toBe(200);
    expect(signUpResponse.headers.get("cache-control")).toBe("no-store");
    const setCookie = signUpResponse.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();

    const sessionResponse = await worker.fetch(
      makeWorkerRequest(`${origin}/v1/auth/get-session`, {
        headers: {
          cookie: setCookie?.split(";", 1)[0] ?? "",
        },
      }),
      integrationEnv,
      createExecutionContext(),
    );

    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.json()).toMatchObject({
      user: {
        email: "alpha-one@example.test",
        name: "Alpha One",
      },
    });
  });

  it("delivers transaction to scheduled Queue publication and duplicate-safe consumption", async () => {
    const accepted = await acceptFixtureEvent();
    expect(accepted._tag).toBe("Accepted");
    if (accepted._tag !== "Accepted") {
      return;
    }

    const queue = new RecordingQueue();
    await runScheduled(queue);

    expect(queue.messages).toHaveLength(1);
    const job = Schema.decodeUnknownSync(OutboxJobV1)(queue.messages[0]);
    expect(job.outboxMessageId).toBe(accepted.outboxMessageId);

    const batch = createMessageBatch("xpensego-platform-jobs-development", [
      {
        id: "first-delivery",
        timestamp: new Date("2026-08-01T00:00:00.000Z"),
        attempts: 1,
        body: job,
      },
      {
        id: "duplicate-delivery",
        timestamp: new Date("2026-08-01T00:00:01.000Z"),
        attempts: 1,
        body: job,
      },
    ]);
    const context = createExecutionContext();
    await worker.queue(batch, makeIntegrationEnv(queue), context);

    const result = await getQueueResult(batch, context);
    expect(result.explicitAcks.toSorted()).toEqual(["duplicate-delivery", "first-delivery"]);
    expect(await readOutboxState(accepted.outboxMessageId)).toEqual({
      status: "published",
      publishAttempts: 1,
      receiptCount: 1,
      deliveryAttempts: 2,
      lastPublishErrorCode: null,
    });

    const missingBatch = createMessageBatch("xpensego-platform-jobs-development", [
      {
        id: "missing-authority",
        timestamp: new Date("2026-08-01T00:00:02.000Z"),
        attempts: 1,
        body: {
          ...job,
          outboxMessageId: Schema.decodeUnknownSync(OutboxMessageId)(
            "ec1c9cd9-cc6b-48a2-90ab-8d298281736c",
          ),
        },
      },
    ]);
    const missingContext = createExecutionContext();
    await worker.queue(missingBatch, makeIntegrationEnv(queue), missingContext);
    expect((await getQueueResult(missingBatch, missingContext)).explicitAcks).toEqual([
      "missing-authority",
    ]);

    const secondQueue = new RecordingQueue();
    await runScheduled(secondQueue);
    expect(secondQueue.messages).toEqual([]);
  });

  it("recovers a failed scheduled publication on the next eligible claim", async () => {
    const accepted = await acceptFixtureEvent();
    expect(accepted._tag).toBe("Accepted");
    if (accepted._tag !== "Accepted") {
      return;
    }

    await runScheduled(new RecordingQueue(1));
    expect(await readOutboxState(accepted.outboxMessageId)).toEqual({
      status: "pending",
      publishAttempts: 1,
      receiptCount: 0,
      deliveryAttempts: 0,
      lastPublishErrorCode: "queue_unavailable",
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          UPDATE outbox_messages
          SET next_publish_attempt_at = CURRENT_TIMESTAMP
          WHERE id = ${accepted.outboxMessageId}
        `;
      }).pipe(Effect.provide(migrationClientLayer), Effect.scoped),
    );

    const recoveredQueue = new RecordingQueue();
    await runScheduled(recoveredQueue);
    expect(recoveredQueue.messages).toHaveLength(1);
    expect(await readOutboxState(accepted.outboxMessageId)).toEqual({
      status: "published",
      publishAttempts: 2,
      receiptCount: 0,
      deliveryAttempts: 0,
      lastPublishErrorCode: null,
    });
  });

  it("retries one receipt failure while acknowledging an unaffected message", async () => {
    const accepted = await acceptFixtureEvent();
    expect(accepted._tag).toBe("Accepted");
    if (accepted._tag !== "Accepted") {
      return;
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`REVOKE INSERT ON outbox_message_receipts FROM xpensego_runtime`;
      }).pipe(Effect.provide(migrationClientLayer), Effect.scoped),
    );

    const batch = createMessageBatch("xpensego-platform-jobs-development", [
      {
        id: "receipt-failure",
        timestamp: new Date("2026-08-01T00:00:03.000Z"),
        attempts: 1,
        body: {
          version: 1,
          kind: "outbox.message.ready",
          outboxMessageId: accepted.outboxMessageId,
          correlationId: Schema.decodeUnknownSync(CorrelationId)(fixtureIds.correlationId),
        },
      },
      {
        id: "unaffected-status",
        timestamp: new Date("2026-08-01T00:00:04.000Z"),
        attempts: 1,
        body: {
          version: 1,
          kind: "platform.status.requested",
          jobId: platformFixtureIds.jobId,
          correlationId: platformFixtureIds.correlationId,
        },
      },
    ]);
    const context = createExecutionContext();
    await worker.queue(batch, makeIntegrationEnv(new RecordingQueue()), context);

    const result = await getQueueResult(batch, context);
    expect(result.explicitAcks).toEqual(["unaffected-status"]);
    expect(result.retryMessages).toEqual([{ msgId: "receipt-failure" }]);
  });
});
