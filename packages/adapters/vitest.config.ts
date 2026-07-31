import { defineConfig } from "vitest/config";

/** Unit-test configuration that excludes PostgreSQL integration tests. */
export default defineConfig({
  test: {
    exclude: ["**/*.integration.test.ts"],
  },
});
