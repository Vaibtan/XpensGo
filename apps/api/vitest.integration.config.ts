import { defineConfig, mergeConfig } from "vitest/config";

import { workerVitestConfig } from "./vitest.config.js";

/** Worker-runtime integration configuration backed by disposable local PostgreSQL. */
export default mergeConfig(
  workerVitestConfig,
  defineConfig({
    test: {
      include: ["src/**/*.integration.test.ts"],
      exclude: [],
      fileParallelism: false,
      testTimeout: 20_000,
      hookTimeout: 30_000,
    },
  }),
);
