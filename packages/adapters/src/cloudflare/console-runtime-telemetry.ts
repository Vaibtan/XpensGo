import {
  RuntimeTelemetry,
  type RuntimeTelemetryService,
} from "@xpensego/domain/platform/runtime-telemetry";
import { Effect, Layer } from "effect";

const make: RuntimeTelemetryService = RuntimeTelemetry.of({
  emit: Effect.fn("ConsoleRuntimeTelemetry.emit")((event) =>
    Effect.sync(() => {
      // oxlint-disable-next-line no-console -- Cloudflare captures console records as structured Worker logs.
      console.info(
        JSON.stringify({
          event: event._tag,
          correlationId: event.correlationId,
          ...("jobId" in event ? { jobId: event.jobId } : {}),
          ...("outboxMessageId" in event ? { outboxMessageId: event.outboxMessageId } : {}),
          ...("attempt" in event ? { attempt: event.attempt } : {}),
          outcome: event.outcome,
        }),
      );
    }),
  ),
});

/** Production Layer that emits content-minimized structured Worker logs. */
export const layer = Layer.succeed(RuntimeTelemetry, make);
