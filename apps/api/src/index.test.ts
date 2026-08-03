import {
  SELF,
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from "cloudflare:test";
import { platformFixtureIds } from "@xpensego/testing/platform/platform-fixtures";
import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import worker from "./index.js";

function unavailableDatabaseEnv(): CloudflareBindings {
  return {
    ...env,
    HYPERDRIVE: {
      ...env.HYPERDRIVE,
      connectionString: "postgresql://xpensego_runtime:unavailable@127.0.0.1:1/xpensego",
    },
  };
}

function databaseForbiddenEnv(): CloudflareBindings {
  const bindings: CloudflareBindings = { ...env };

  Object.defineProperty(bindings, "HYPERDRIVE", {
    get() {
      throw new Error("A database-free Queue job must not read the Hyperdrive binding.");
    },
  });

  return bindings;
}

function telegramDatabaseForbiddenEnv(secret: string): CloudflareBindings {
  const bindings = databaseForbiddenEnv();
  Object.defineProperty(bindings, "TELEGRAM_WEBHOOK_SECRET", { value: secret });
  return bindings;
}

function defectiveRuntimeEnv(): CloudflareBindings {
  const bindings: CloudflareBindings = { ...env };

  Object.defineProperty(bindings, "SERVICE_NAME", {
    get() {
      throw new Error("simulated unclassified runtime defect");
    },
  });

  return bindings;
}

const validProbeBindings = {
  BUILD_REVISION: "0123456789abcdef0123456789abcdef01234567",
  PHASE1_PROBE_SECRET: "integration-authorization-secret-at-least-32-characters",
  PHASE1_PROBE_SIGNING_SECRET: "integration-signing-secret-at-least-32-characters",
} as const;

const validProbeCommand = {
  operation: "acceptInboundEvent",
  runId: "unit-run",
  ownerUserId: "0a37f42e-a007-4d0d-adc2-98098f486ecc",
  ledgerId: "34502fb7-d5c9-4a30-a480-54c66583240a",
  otherOwnerUserId: "8ed91076-bdf7-4406-8579-d8031dca3267",
} as const;

function makeWorkerRequest(url: string, init?: RequestInit): Parameters<typeof worker.fetch>[0] {
  // SAFETY: the Workers test pool constructs the same runtime Request but exposes a wider cf generic.
  return new Request(url, init) as Parameters<typeof worker.fetch>[0];
}

describe("Xpensego API Worker", () => {
  it("serves a versioned status response through the real fetch entrypoint", async () => {
    const response = await SELF.fetch("https://xpensego.test/v1/platform/status", {
      headers: {
        "x-correlation-id": platformFixtureIds.correlationId,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      version: 1,
      status: "ready",
      service: "xpensego-api",
      environment: "development",
      correlationId: platformFixtureIds.correlationId,
    });
  });

  it("serves OpenAPI from the same contract as the status route", async () => {
    const response = await SELF.fetch("https://xpensego.test/v1/openapi.json");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      openapi: "3.1.0",
      paths: {
        "/v1/platform/status": {
          get: {
            responses: {
              "400": {},
              "500": {},
            },
          },
        },
        "/v1/identity": {
          get: {
            responses: {
              "200": {},
              "401": {},
              "403": {},
              "503": {},
            },
          },
        },
        "/v1/identity/telegram/unlink-challenges": {
          post: {
            responses: {
              "201": {},
              "400": {},
              "401": {},
              "403": {},
              "404": {},
              "429": {},
              "503": {},
            },
          },
        },
      },
    });
  });

  it("serves database-free routes without reading the Hyperdrive binding", async () => {
    const bindings = databaseForbiddenEnv();
    const statusResponse = await worker.fetch(
      makeWorkerRequest("https://xpensego.test/v1/platform/status"),
      bindings,
      createExecutionContext(),
    );
    const openApiResponse = await worker.fetch(
      makeWorkerRequest("https://xpensego.test/v1/openapi.json"),
      bindings,
      createExecutionContext(),
    );

    expect(statusResponse.status).toBe(200);
    expect(openApiResponse.status).toBe(200);
  });

  it("rejects an invalid Telegram webhook secret before acquiring database resources", async () => {
    const response = await worker.fetch(
      makeWorkerRequest("https://xpensego.test/v1/channels/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "wrong-secret",
        },
        body: "{}",
      }),
      telegramDatabaseForbiddenEnv("configured-telegram-secret"),
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("acknowledges an authenticated group update without reading personal data stores", async () => {
    const webhookSecret = "configured-telegram-secret";
    const response = await worker.fetch(
      makeWorkerRequest("https://xpensego.test/v1/channels/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": webhookSecret,
        },
        body: JSON.stringify({
          update_id: 9001,
          message: {
            message_id: 22,
            date: 1_785_638_401,
            chat: { id: -100_123_456, type: "supergroup" },
            from: { id: 123_456, is_bot: false },
            text: "show my ledger",
          },
        }),
      }),
      telegramDatabaseForbiddenEnv(webhookSecret),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "ignored" });
  });

  it("returns a safe versioned not-found response", async () => {
    const response = await SELF.fetch("https://xpensego.test/not-a-route", {
      headers: {
        "x-correlation-id": platformFixtureIds.correlationId,
      },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      version: 1,
      error: {
        code: "route_not_found",
        message: "The requested route does not exist.",
        correlationId: platformFixtureIds.correlationId,
      },
    });
  });

  it("does not expose the staging acceptance driver in development", async () => {
    const response = await worker.fetch(
      makeWorkerRequest("https://xpensego.test/_internal/phase1-staging-proof", {
        method: "POST",
        headers: {
          authorization: `Bearer ${validProbeBindings.PHASE1_PROBE_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(validProbeCommand),
      }),
      {
        ...env,
        ...validProbeBindings,
      },
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
  });

  it("hides the staging acceptance driver when authorization is invalid", async () => {
    const response = await worker.fetch(
      makeWorkerRequest("https://xpensego.test/_internal/phase1-staging-proof", {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(validProbeCommand),
      }),
      {
        ...env,
        ENVIRONMENT: "staging",
        ...validProbeBindings,
      },
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
  });

  it("rejects a probe configuration that reuses its authorization secret for signing", async () => {
    const response = await worker.fetch(
      makeWorkerRequest("https://xpensego.test/_internal/phase1-staging-proof", {
        method: "POST",
        headers: {
          authorization: `Bearer ${validProbeBindings.PHASE1_PROBE_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(validProbeCommand),
      }),
      {
        ...env,
        ENVIRONMENT: "staging",
        ...validProbeBindings,
        PHASE1_PROBE_SIGNING_SECRET: validProbeBindings.PHASE1_PROBE_SECRET,
      },
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
  });

  it("acknowledges a database-free job without reading the Hyperdrive binding", async () => {
    const batch = createMessageBatch("xpensego-platform-jobs-development", [
      {
        id: "queue-message-1",
        timestamp: new Date("2026-07-31T00:00:00.000Z"),
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

    await worker.queue(batch, databaseForbiddenEnv(), context);

    const result = await getQueueResult(batch, context);
    expect(result.explicitAcks).toEqual(["queue-message-1"]);
  });

  it("drops only an invalid envelope while continuing the rest of its batch", async () => {
    const batch = createMessageBatch("xpensego-platform-jobs-development", [
      {
        id: "invalid-message",
        timestamp: new Date("2026-07-31T00:00:00.000Z"),
        attempts: 1,
        body: {
          version: 99,
          kind: "platform.status.requested",
          jobId: platformFixtureIds.jobId,
          correlationId: platformFixtureIds.correlationId,
        },
      },
      {
        id: "valid-message",
        timestamp: new Date("2026-07-31T00:00:00.000Z"),
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

    await worker.queue(batch, env, context);

    const result = await getQueueResult(batch, context);
    expect(result.ackAll).toBe(false);
    expect(result.explicitAcks).toEqual(["invalid-message", "valid-message"]);
  });

  it("acks a database-free job while retrying only an unavailable outbox job", async () => {
    const batch = createMessageBatch("xpensego-platform-jobs-development", [
      {
        id: "status-message",
        timestamp: new Date("2026-07-31T00:00:00.000Z"),
        attempts: 1,
        body: {
          version: 1,
          kind: "platform.status.requested",
          jobId: platformFixtureIds.jobId,
          correlationId: platformFixtureIds.correlationId,
        },
      },
      {
        id: "outbox-message",
        timestamp: new Date("2026-07-31T00:00:00.000Z"),
        attempts: 1,
        body: {
          version: 1,
          kind: "outbox.message.ready",
          outboxMessageId: Schema.decodeUnknownSync(OutboxMessageId)(
            "98b2ea19-c24e-49a3-a808-f39667b3c32e",
          ),
          correlationId: platformFixtureIds.correlationId,
        },
      },
    ]);
    const context = createExecutionContext();

    await worker.queue(batch, unavailableDatabaseEnv(), context);

    const result = await getQueueResult(batch, context);
    expect(result.retryBatch).toEqual({ retry: false });
    expect(result.explicitAcks).toEqual(["status-message"]);
    expect(result.retryMessages).toEqual([{ msgId: "outbox-message" }]);
  });

  it("retries only the outbox message when its PostgreSQL Layer is unavailable", async () => {
    const batch = createMessageBatch("xpensego-platform-jobs-development", [
      {
        id: "unavailable-outbox-message",
        timestamp: new Date("2026-07-31T00:00:00.000Z"),
        attempts: 1,
        body: {
          version: 1,
          kind: "outbox.message.ready",
          outboxMessageId: Schema.decodeUnknownSync(OutboxMessageId)(
            "98b2ea19-c24e-49a3-a808-f39667b3c32e",
          ),
          correlationId: platformFixtureIds.correlationId,
        },
      },
    ]);
    const context = createExecutionContext();
    await worker.queue(batch, unavailableDatabaseEnv(), context);

    const result = await getQueueResult(batch, context);
    expect(result.retryBatch).toEqual({ retry: false });
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: "unavailable-outbox-message" }]);
  });

  it("does not blindly retry a batch after an unclassified defect", async () => {
    const batch = createMessageBatch("xpensego-platform-jobs-development", [
      {
        id: "defective-status-message",
        timestamp: new Date("2026-07-31T00:00:00.000Z"),
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

    await worker.queue(batch, defectiveRuntimeEnv(), context);

    const result = await getQueueResult(batch, context);
    expect(result.ackAll).toBe(true);
    expect(result.retryBatch).toEqual({ retry: false });
    expect(result.retryMessages).toEqual([]);
  });
});
