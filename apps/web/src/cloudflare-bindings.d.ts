export {};

declare global {
  /** Checked-in OpenNext bindings required by server-side application code. */
  interface CloudflareEnv {
    API: {
      fetch(request: Request): Promise<Response>;
    };
    BUILD_REVISION?: string;
  }
}
