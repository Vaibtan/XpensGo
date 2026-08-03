export {};

declare global {
  /**
   * Deliberate augmentation for out-of-band Worker secrets.
   *
   * `wrangler types` owns every binding in wrangler.jsonc. Secret names and values remain outside
   * that committed file, so only their optional names are augmented for local tests and route-local
   * runtime validation.
   */
  interface CloudflareBindings {
    readonly BETTER_AUTH_SECRET?: string;
    readonly BUILD_REVISION?: string;
    readonly PHASE1_PROBE_SECRET?: string;
    readonly PHASE1_PROBE_SIGNING_SECRET?: string;
    readonly TELEGRAM_BOT_TOKEN?: string;
    readonly TELEGRAM_WEBHOOK_SECRET?: string;
  }
}
