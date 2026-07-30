import { RuntimeEnvironment } from "@xpensego/contracts/platform/platform-status";
import { RuntimeConfig } from "@xpensego/domain/platform/runtime-config";
import { Effect, Layer, Schema } from "effect";

const RuntimeConfigSchema = Schema.Struct({
  environment: RuntimeEnvironment,
  serviceName: Schema.NonEmptyString,
});

/** Raw Cloudflare bindings selected by the API composition root. */
export type RuntimeConfigInput = {
  /** Untrusted environment binding. */
  readonly environment: unknown;

  /** Untrusted service-name binding. */
  readonly serviceName: unknown;
};

/** Safe startup failure returned when runtime bindings cannot be parsed. */
export class InvalidRuntimeConfig extends Schema.TaggedError<InvalidRuntimeConfig>()(
  "InvalidRuntimeConfig",
  {
    bindingNames: Schema.Array(Schema.String),
  },
) {
  /** Human-readable startup failure that never includes binding values. */
  override get message(): string {
    return `Invalid runtime configuration: ${this.bindingNames.join(", ")}`;
  }
}

/**
 * Build an invocation-scoped Layer from untrusted Cloudflare bindings.
 *
 * @param input - The raw binding values selected by the Worker entrypoint.
 * @returns A Layer that provides validated runtime configuration.
 */
export function makeRuntimeConfigLayer(
  input: RuntimeConfigInput,
): Layer.Layer<RuntimeConfig, InvalidRuntimeConfig> {
  const make = Schema.decodeUnknown(RuntimeConfigSchema)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(
      () =>
        new InvalidRuntimeConfig({
          bindingNames: ["ENVIRONMENT", "SERVICE_NAME"],
        }),
    ),
    Effect.map((config) => RuntimeConfig.of(config)),
  );

  return Layer.effect(RuntimeConfig, make);
}
