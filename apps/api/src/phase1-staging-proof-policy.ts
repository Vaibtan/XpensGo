/** Cloudflare Cron cadence for the staging outbox dispatcher. */
export const dispatcherCronPeriodMilliseconds = 10 * 60 * 1_000;

/** Neon default idle threshold plus one minute for an observable idle state. */
export const coldResumeIdleWindowMilliseconds = 6 * 60 * 1_000;

/** Bound for every managed HTTP call, including the Hyperdrive cold reconnect. */
export const coldResumeRequestTimeoutMilliseconds = 10_000;

/** User-visible reconnect acceptance bound for the complete authenticated request. */
export const maximumColdResumeLatencyMilliseconds = 10_000;

/** Maximum wait for the ten-minute Cron plus Queue delivery and polling slack. */
export const maximumScheduledRecoveryWaitMilliseconds = 11 * 60 * 1_000 + 15_000;

/** Maximum alignment delay before a complete cold-resume observation window. */
export const maximumColdWindowAlignmentWaitMilliseconds = 7 * 60 * 1_000;

/** Workflow-level budget excluding dependency installation and other fixed setup. */
export const maximumManagedProofMilliseconds = 26 * 60 * 1_000;

const cronSafetyMarginMilliseconds = 30_000;

/**
 * Compute the delay needed before observing an uninterrupted Neon idle window.
 * The window begins after an in-flight cron boundary and ends before the next one.
 */
export function coldResumeWaitMilliseconds(currentTimeMilliseconds: number): number {
  const elapsedInPeriod = currentTimeMilliseconds % dispatcherCronPeriodMilliseconds;
  const untilNextCron = dispatcherCronPeriodMilliseconds - elapsedInPeriod;

  if (elapsedInPeriod < cronSafetyMarginMilliseconds) {
    return cronSafetyMarginMilliseconds - elapsedInPeriod;
  }
  if (untilNextCron > coldResumeIdleWindowMilliseconds + cronSafetyMarginMilliseconds) {
    return 0;
  }
  return untilNextCron + cronSafetyMarginMilliseconds;
}
