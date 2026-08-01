export {};

declare global {
  /** Secret binding is optional in local tests and required by runtime validation for auth routes. */
  interface CloudflareBindings {
    readonly BETTER_AUTH_SECRET?: string;
  }
}
