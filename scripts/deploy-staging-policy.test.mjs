import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertDeployableStatus } from "./deploy-staging-policy.mjs";

await describe("verified staging deployment policy", async () => {
  await it("accepts an empty scoped porcelain status", () => {
    assert.doesNotThrow(() => assertDeployableStatus(""));
  });

  await it("rejects staged, unstaged, and untracked deployment inputs", () => {
    for (const status of [
      "M  apps/api/src/index.ts",
      " M apps/web/src/app/page.tsx",
      "?? scripts/new-deployment-input.mjs",
    ]) {
      assert.throws(() => assertDeployableStatus(status), /Commit all staging deployment inputs/);
    }
  });
});
