import { describe, expect, it } from "vitest";

import {
  coldResumeIdleWindowMilliseconds,
  coldResumeRequestTimeoutMilliseconds,
  coldResumeWaitMilliseconds,
  dispatcherCronPeriodMilliseconds,
  maximumColdResumeLatencyMilliseconds,
  maximumColdWindowAlignmentWaitMilliseconds,
  maximumManagedProofMilliseconds,
  maximumScheduledRecoveryWaitMilliseconds,
} from "./phase1-staging-proof-policy.js";

describe("Phase 1 staging proof timing policy", () => {
  it("waits beyond a cron that may still be running", () => {
    expect(coldResumeWaitMilliseconds(0)).toBe(30_000);
    expect(coldResumeWaitMilliseconds(15_000)).toBe(15_000);
  });

  it("starts immediately when a complete idle window fits before the next cron", () => {
    expect(coldResumeWaitMilliseconds(60_000)).toBe(0);
  });

  it("waits through the next cron when the current period is too short", () => {
    const eightMinutesIntoPeriod = 8 * 60 * 1_000;
    expect(coldResumeWaitMilliseconds(eightMinutesIntoPeriod)).toBe(2 * 60 * 1_000 + 30_000);
  });

  it("keeps the idle and request bounds inside one dispatcher period", () => {
    expect(coldResumeIdleWindowMilliseconds + 30_000).toBeLessThan(
      dispatcherCronPeriodMilliseconds,
    );
    expect(maximumColdResumeLatencyMilliseconds).toBe(coldResumeRequestTimeoutMilliseconds);
  });

  it("keeps worst-case managed waits inside the workflow execution budget", () => {
    expect(
      maximumScheduledRecoveryWaitMilliseconds +
        maximumColdWindowAlignmentWaitMilliseconds +
        coldResumeIdleWindowMilliseconds +
        coldResumeRequestTimeoutMilliseconds,
    ).toBeLessThanOrEqual(maximumManagedProofMilliseconds);
  });
});
