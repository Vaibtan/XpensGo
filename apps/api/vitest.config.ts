import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig, mergeConfig } from "vitest/config";

/** Shared Worker runtime and dependency optimizer for API test suites. */
export const workerVitestConfig = defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
    }),
  ],
  test: {
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["pg"],
          exclude: [
            "crypto",
            "dns",
            "events",
            "fs",
            "net",
            "path",
            "stream",
            "string_decoder",
            "tls",
            "util",
            "util/types",
          ],
        },
      },
    },
  },
});

/** Worker-runtime Vitest configuration for credential-free API tests. */
export default mergeConfig(
  workerVitestConfig,
  defineConfig({
    test: {
      include: ["src/**/*.test.ts"],
      exclude: ["src/**/*.integration.test.ts"],
    },
  }),
);
