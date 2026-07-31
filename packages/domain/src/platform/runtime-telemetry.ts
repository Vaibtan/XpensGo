import type { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import type { JobId } from "@xpensego/contracts/platform/job-id";
import type { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import { Context, type Effect } from "effect";

/** Content-minimized application telemetry emitted by the platform tracer. */
export type RuntimeTelemetryEvent =
  | {
      readonly _tag: "PlatformStatusRead";
      readonly correlationId: CorrelationId;
      readonly outcome: "ready";
    }
  | {
      readonly _tag: "PlatformStatusJobProcessed";
      readonly correlationId: CorrelationId;
      readonly jobId: JobId;
      readonly outcome: "processed";
    }
  | {
      readonly _tag: "OutboxPublicationSucceeded";
      readonly correlationId: CorrelationId;
      readonly outboxMessageId: OutboxMessageId;
      readonly attempt: number;
      readonly outcome: "published";
    }
  | {
      readonly _tag: "OutboxPublicationDeferred";
      readonly correlationId: CorrelationId;
      readonly outboxMessageId: OutboxMessageId;
      readonly attempt: number;
      readonly outcome: "deferred";
    }
  | {
      readonly _tag: "OutboxPublicationFailed";
      readonly correlationId: CorrelationId;
      readonly outboxMessageId: OutboxMessageId;
      readonly attempt: number;
      readonly outcome: "failed";
    }
  | {
      readonly _tag: "OutboxConsumptionRecorded";
      readonly correlationId: CorrelationId;
      readonly outboxMessageId: OutboxMessageId;
      readonly outcome: "processed" | "duplicate" | "not_found";
    };

/** Application-owned port for recording safe runtime events. */
export interface RuntimeTelemetryService {
  /**
   * Record a content-minimized runtime event.
   *
   * @param event - The safe application event to record.
   * @returns An Effect that completes when the adapter accepts the event.
   */
  readonly emit: (event: RuntimeTelemetryEvent) => Effect.Effect<void>;
}

/** Authority seam for application telemetry without provider-specific values. */
export class RuntimeTelemetry extends Context.Tag("@xpensego/domain/platform/RuntimeTelemetry")<
  RuntimeTelemetry,
  RuntimeTelemetryService
>() {}
