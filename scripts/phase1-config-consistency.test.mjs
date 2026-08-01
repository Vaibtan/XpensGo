import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await describe("Phase 1 managed proof configuration", async () => {
  await it("keeps the Wrangler cron cadence aligned with the tested proof policy", async () => {
    const [wranglerConfig, policy] = await Promise.all([
      readFile(path.join(repositoryRoot, "apps/api/wrangler.jsonc"), "utf8"),
      readFile(path.join(repositoryRoot, "apps/api/src/phase1-staging-proof-policy.ts"), "utf8"),
    ]);

    assert.match(wranglerConfig, /"crons": \["\*\/10 \* \* \* \*"\]/);
    assert.match(policy, /dispatcherCronPeriodMilliseconds = 10 \* 60 \* 1_000/);
  });

  await it("keeps the workflow timeout above the tested managed-proof budget", async () => {
    const [workflow, policy] = await Promise.all([
      readFile(path.join(repositoryRoot, ".github/workflows/phase1-staging-proof.yml"), "utf8"),
      readFile(path.join(repositoryRoot, "apps/api/src/phase1-staging-proof-policy.ts"), "utf8"),
    ]);

    assert.match(workflow, /timeout-minutes: 35/);
    assert.match(policy, /maximumManagedProofMilliseconds = 26 \* 60 \* 1_000/);
  });

  await it("binds both deployed Workers and the proof client to the workflow revision", async () => {
    const [deploymentScript, workflow] = await Promise.all([
      readFile(path.join(repositoryRoot, "scripts/deploy-staging.mjs"), "utf8"),
      readFile(path.join(repositoryRoot, ".github/workflows/phase1-staging-proof.yml"), "utf8"),
    ]);

    assert.equal(deploymentScript.match(/secret", "put", "BUILD_REVISION"/g)?.length, 2);
    assert.match(deploymentScript, /readGit\(\["rev-parse", "HEAD"\]\)/);
    assert.match(workflow, /XPENSEGO_EXPECTED_REVISION: \$\{\{ github\.sha \}\}/);
  });
});
