export {};

declare global {
  /** Secret binding is optional in local tests and required by runtime validation for auth routes. */
  interface CloudflareBindings {
    readonly BETTER_AUTH_SECRET?: string;
    readonly BUILD_REVISION?: string;
    readonly PHASE1_PROBE_SECRET?: string;
    readonly PHASE1_PROBE_SIGNING_SECRET?: string;
  }
}
