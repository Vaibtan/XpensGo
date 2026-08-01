import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertDeployableStatus, resolvePackageCommand } from "./deploy-staging-policy.mjs";

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

  await it("runs npm and npx through Node instead of Windows command shims", () => {
    const npmCliPath = "C:\\tools\\npm\\bin\\npm-cli.js";
    assert.deepEqual(
      resolvePackageCommand({
        command: "npm",
        args: ["run", "deploy"],
        nodeExecutable: "C:\\node\\node.exe",
        npmCliPath,
        platform: "win32",
      }),
      {
        command: "C:\\node\\node.exe",
        args: [npmCliPath, "run", "deploy"],
      },
    );
    assert.deepEqual(
      resolvePackageCommand({
        command: "npx",
        args: ["wrangler", "secret", "list"],
        nodeExecutable: "C:\\node\\node.exe",
        npmCliPath,
        platform: "win32",
      }),
      {
        command: "C:\\node\\node.exe",
        args: ["C:\\tools\\npm\\bin\\npx-cli.js", "wrangler", "secret", "list"],
      },
    );
  });

  await it("keeps native package commands on non-Windows platforms", () => {
    assert.deepEqual(
      resolvePackageCommand({
        command: "npm",
        args: ["run", "deploy"],
        nodeExecutable: "/usr/bin/node",
        npmCliPath: "/usr/lib/node_modules/npm/bin/npm-cli.js",
        platform: "linux",
      }),
      { command: "npm", args: ["run", "deploy"] },
    );
  });
});
