import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateDependencyAuditPolicy } from "./dependency-audit-policy.mjs";

const activePolicy = {
  expiresAt: "2026-08-15",
  packageVulnerabilities: {
    postcss: { maximumSeverity: "high", isDirect: false },
  },
  advisories: {
    1124288: {
      ghsa: "GHSA-r28c-9q8g-f849",
      package: "postcss",
      allowedInstalledVersions: ["8.4.31"],
      affectedRange: "<=8.5.17",
      maximumSeverity: "high",
      disposition: "No attacker-controlled CSS is processed.",
    },
  },
};

const reviewedReport = {
  vulnerabilities: {
    postcss: {
      severity: "high",
      isDirect: false,
      nodes: ["node_modules/next/node_modules/postcss"],
      via: [
        {
          source: 1124288,
          name: "postcss",
          dependency: "postcss",
          url: "https://github.com/advisories/GHSA-r28c-9q8g-f849",
          severity: "high",
          range: "<=8.5.17",
        },
      ],
    },
  },
};

const reviewedLockfile = {
  packages: {
    "node_modules/next/node_modules/postcss": { version: "8.4.31" },
  },
};

const evaluate = ({
  policy = activePolicy,
  report = reviewedReport,
  lockfile = reviewedLockfile,
  now = new Date("2026-08-01T00:00:00.000Z"),
} = {}) => evaluateDependencyAuditPolicy({ policy, report, lockfile, now });

await describe("dependency audit policy", async () => {
  await it("accepts only the reviewed package and advisory before expiry", () => {
    assert.deepEqual(evaluate(), {
      _tag: "Accepted",
      message:
        "Dependency audit accepted 1 reviewed package findings covered by 1 current advisories; policy expires 2026-08-15.",
    });
  });

  await it("accepts a clean report without relying on an exception", () => {
    assert.deepEqual(
      evaluate({ report: { vulnerabilities: {} }, now: new Date("2027-01-01T00:00:00Z") }),
      { _tag: "Accepted", message: "Dependency audit passed with no findings." },
    );
  });

  await it("rejects an expired exception", () => {
    assert.deepEqual(evaluate({ now: new Date("2026-08-16T00:00:00Z") }), {
      _tag: "Rejected",
      reasons: ["dependency-audit policy expired on 2026-08-15"],
    });
  });

  await it("rejects an unreviewed package", () => {
    assert.deepEqual(
      evaluate({
        report: {
          vulnerabilities: {
            next: {
              severity: "high",
              isDirect: true,
              nodes: ["node_modules/next"],
              via: [{ source: 9999999 }],
            },
          },
        },
      }),
      { _tag: "Rejected", reasons: ["unapproved vulnerable package next"] },
    );
  });

  await it("rejects aggregate severity, directness, and advisory drift", () => {
    assert.deepEqual(
      evaluate({
        report: {
          vulnerabilities: {
            postcss: {
              severity: "critical",
              isDirect: true,
              nodes: ["node_modules/next/node_modules/postcss"],
              via: [{ source: 9999999 }],
            },
          },
        },
      }),
      {
        _tag: "Rejected",
        reasons: [
          "postcss severity critical exceeds high",
          "postcss direct-dependency status changed",
          "unapproved or invalid advisory source 9999999 affects postcss",
        ],
      },
    );
  });

  await it("rejects inherited object keys used as severity values", () => {
    const maliciousReport = structuredClone(reviewedReport);
    maliciousReport.vulnerabilities.postcss.severity = "__proto__";
    maliciousReport.vulnerabilities.postcss.via[0].severity = "toString";

    assert.deepEqual(evaluate({ report: maliciousReport }), {
      _tag: "Rejected",
      reasons: [
        "postcss severity __proto__ exceeds high",
        "advisory source 1124288 severity exceeds high",
      ],
    });
  });

  await it("rejects advisory metadata and installed-version drift", () => {
    const driftedReport = structuredClone(reviewedReport);
    driftedReport.vulnerabilities.postcss.via[0].severity = "critical";
    driftedReport.vulnerabilities.postcss.via[0].range = "<9.0.0";

    assert.deepEqual(
      evaluate({
        report: driftedReport,
        lockfile: {
          packages: {
            "node_modules/next/node_modules/postcss": { version: "8.4.32" },
          },
        },
      }),
      {
        _tag: "Rejected",
        reasons: [
          "advisory source 1124288 severity exceeds high",
          "advisory source 1124288 identity or affected range changed",
          "advisory source 1124288 has unreviewed installed version 8.4.32",
        ],
      },
    );
  });

  await it("rejects malformed advisory variants and missing transitive references", () => {
    assert.deepEqual(
      evaluate({
        report: {
          vulnerabilities: {
            postcss: {
              severity: "high",
              isDirect: false,
              nodes: ["node_modules/next/node_modules/postcss"],
              via: [{ severity: "high" }, "toString"],
            },
          },
        },
      }),
      {
        _tag: "Rejected",
        reasons: [
          "npm audit returned an invalid advisory for postcss",
          "npm audit references missing vulnerability toString from postcss",
        ],
      },
    );
  });

  await it("rejects malformed policy, report, and lockfile inputs", () => {
    assert.deepEqual(evaluate({ policy: {} }), {
      _tag: "Rejected",
      reasons: ["dependency-audit policy has an invalid shape"],
    });
    assert.deepEqual(evaluate({ report: {} }), {
      _tag: "Rejected",
      reasons: ["npm audit report has an invalid shape"],
    });
    assert.deepEqual(evaluate({ lockfile: {} }), {
      _tag: "Rejected",
      reasons: ["package lockfile has an invalid shape"],
    });
  });
});
