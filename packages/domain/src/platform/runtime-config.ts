import type { RuntimeEnvironment } from "@xpensego/contracts/platform/platform-status";
import { Context } from "effect";

/** Validated runtime configuration available to application programs. */
export interface RuntimeConfigService {
  /** Deployment environment selected by the composition root. */
  readonly environment: RuntimeEnvironment;

  /** Stable service name used in public status and telemetry records. */
  readonly serviceName: string;
}

/** Authority seam for validated invocation configuration. */
export class RuntimeConfig extends Context.Tag("@xpensego/domain/platform/RuntimeConfig")<
  RuntimeConfig,
  RuntimeConfigService
>() {}
