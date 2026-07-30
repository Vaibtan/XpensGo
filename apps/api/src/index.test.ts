import {
  SELF,
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from "cloudflare:test";
import { platformFixtureIds } from "@xpensego/testing/platform/platform-fixtures";
import { describe, expect, it } from "vitest";

import worker from "./index.js";

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

  it("acknowledges a valid versioned job through the real queue entrypoint", async () => {
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

    await worker.queue(batch, env, context);

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
});
