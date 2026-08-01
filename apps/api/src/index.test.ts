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

function defectiveRuntimeEnv(): CloudflareBindings {
  const bindings: CloudflareBindings = { ...env };

  Object.defineProperty(bindings, "SERVICE_NAME", {
    get() {
      throw new Error("simulated unclassified runtime defect");
    },
  });

  return bindings;
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
      },
    });
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
