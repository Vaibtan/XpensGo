import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { evaluateDependencyAuditPolicy } from "./dependency-audit-policy.mjs";

const policyUrl = new URL("../.github/dependency-audit-allowlist.json", import.meta.url);
const lockfileUrl = new URL("../package-lock.json", import.meta.url);
const workspacePath = fileURLToPath(new URL("..", import.meta.url));

const fail = (message) => {
  console.error(message);
  process.exitCode = 1;
};

const loadJson = (url, name) => {
  try {
    return { _tag: "Loaded", value: JSON.parse(readFileSync(url, "utf8")) };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "unknown read failure";
    return { _tag: "LoadFailed", message: `${name} could not be read as JSON: ${detail}` };
  }
};

const policyResult = loadJson(policyUrl, "dependency-audit policy");
const lockfileResult = loadJson(lockfileUrl, "package lockfile");

if (policyResult._tag === "LoadFailed") {
  fail(policyResult.message);
} else if (lockfileResult._tag === "LoadFailed") {
  fail(lockfileResult.message);
} else {
  const audit = spawnSync("npm", ["audit", "--json", "--package-lock-only"], {
    cwd: workspacePath,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (audit.error !== undefined) {
    fail(`npm audit could not start: ${audit.error.message}`);
  } else if (audit.status !== 0 && audit.status !== 1) {
    fail(`npm audit failed before producing a policy-checkable report (${String(audit.status)})`);
  } else {
    let report;
    try {
      report = JSON.parse(audit.stdout);
    } catch {
      fail("npm audit did not produce valid JSON");
    }

    if (report !== undefined) {
      const result = evaluateDependencyAuditPolicy({
        policy: policyResult.value,
        report,
        lockfile: lockfileResult.value,
        now: new Date(),
      });
      if (result._tag === "Rejected") {
        fail(`Dependency audit policy rejected the report:\n- ${result.reasons.join("\n- ")}`);
      } else {
        console.log(result.message);
      }
    }
  }
}
