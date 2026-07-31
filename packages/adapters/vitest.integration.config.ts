import { defineConfig } from "vitest/config";

/** Real-PostgreSQL integration-test configuration. */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
