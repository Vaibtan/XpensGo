const severityRank = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const reject = (...reasons) => ({ _tag: "Rejected", reasons });

const isSeverity = (value) => typeof value === "string" && Object.hasOwn(severityRank, value);

const parseAdvisoryPolicy = (value) => {
  if (
    !isRecord(value) ||
    typeof value.ghsa !== "string" ||
    !/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(value.ghsa) ||
    typeof value.package !== "string" ||
    !Array.isArray(value.allowedInstalledVersions) ||
    value.allowedInstalledVersions.length === 0 ||
    !value.allowedInstalledVersions.every((version) => typeof version === "string") ||
    typeof value.affectedRange !== "string" ||
    !isSeverity(value.maximumSeverity) ||
    typeof value.disposition !== "string" ||
    value.disposition.trim().length === 0
  ) {
    return { _tag: "Invalid" };
  }

  return { _tag: "Parsed", value };
};

/**
 * Compare an npm audit report with the repository's time-bounded review policy.
 *
 * The policy permits findings to disappear, but rejects every new package or
 * advisory, metadata or installed-version drift, severity increase,
 * directness change, malformed report, or expired exception. The caller owns
 * rendering the result as a CLI or CI outcome.
 *
 * @param {{ readonly policy: unknown, readonly report: unknown, readonly lockfile: unknown, readonly now: Date }} input - Untrusted policy, npm audit data, lockfile data, and evaluation time.
 * @returns {{ readonly _tag: "Accepted", readonly message: string } | { readonly _tag: "Rejected", readonly reasons: ReadonlyArray<string> }} The policy decision.
 */
export function evaluateDependencyAuditPolicy({ policy, report, lockfile, now }) {
  if (
    !isRecord(policy) ||
    !isRecord(policy.packageVulnerabilities) ||
    !isRecord(policy.advisories)
  ) {
    return reject("dependency-audit policy has an invalid shape");
  }

  if (!isRecord(report) || !isRecord(report.vulnerabilities)) {
    return reject("npm audit report has an invalid shape");
  }

  if (!isRecord(lockfile) || !isRecord(lockfile.packages)) {
    return reject("package lockfile has an invalid shape");
  }

  const currentEntries = Object.entries(report.vulnerabilities);
  if (currentEntries.length === 0) {
    return { _tag: "Accepted", message: "Dependency audit passed with no findings." };
  }

  if (typeof policy.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(policy.expiresAt)) {
    return reject("dependency-audit policy expiry must use YYYY-MM-DD");
  }

  const expiry = Date.parse(`${policy.expiresAt}T23:59:59.999Z`);
  if (!Number.isFinite(expiry) || now.getTime() > expiry) {
    return reject(`dependency-audit policy expired on ${policy.expiresAt}`);
  }

  const failures = [];
  const observedAdvisories = new Set();

  for (const [packageName, vulnerability] of currentEntries) {
    const approved = policy.packageVulnerabilities[packageName];

    if (
      !isRecord(vulnerability) ||
      !Array.isArray(vulnerability.via) ||
      !Array.isArray(vulnerability.nodes) ||
      !vulnerability.nodes.every((node) => typeof node === "string")
    ) {
      failures.push(`npm audit returned an invalid vulnerability for ${packageName}`);
      continue;
    }

    if (!isRecord(approved)) {
      failures.push(`unapproved vulnerable package ${packageName}`);
      continue;
    }

    if (
      !isSeverity(vulnerability.severity) ||
      !isSeverity(approved.maximumSeverity) ||
      severityRank[vulnerability.severity] > severityRank[approved.maximumSeverity]
    ) {
      failures.push(
        `${packageName} severity ${String(vulnerability.severity)} exceeds ${String(approved.maximumSeverity)}`,
      );
    }

    if (
      typeof vulnerability.isDirect !== "boolean" ||
      vulnerability.isDirect !== approved.isDirect
    ) {
      failures.push(`${packageName} direct-dependency status changed`);
    }

    for (const cause of vulnerability.via) {
      if (typeof cause === "string") {
        if (!Object.hasOwn(report.vulnerabilities, cause)) {
          failures.push(`npm audit references missing vulnerability ${cause} from ${packageName}`);
        }
        continue;
      }

      if (!isRecord(cause) || !("source" in cause)) {
        failures.push(`npm audit returned an invalid advisory for ${packageName}`);
        continue;
      }

      const source = String(cause.source);
      observedAdvisories.add(source);
      const advisoryResult = parseAdvisoryPolicy(policy.advisories[source]);
      if (advisoryResult._tag === "Invalid") {
        failures.push(`unapproved or invalid advisory source ${source} affects ${packageName}`);
        continue;
      }

      const advisory = advisoryResult.value;
      const expectedUrl = `https://github.com/advisories/${advisory.ghsa}`;
      if (
        advisory.package !== packageName ||
        cause.name !== packageName ||
        cause.dependency !== packageName
      ) {
        failures.push(`advisory source ${source} package identity changed`);
      }
      if (
        !isSeverity(cause.severity) ||
        severityRank[cause.severity] > severityRank[advisory.maximumSeverity]
      ) {
        failures.push(`advisory source ${source} severity exceeds ${advisory.maximumSeverity}`);
      }
      if (cause.url !== expectedUrl || cause.range !== advisory.affectedRange) {
        failures.push(`advisory source ${source} identity or affected range changed`);
      }

      for (const node of vulnerability.nodes) {
        const installedPackage = lockfile.packages[node];
        if (!isRecord(installedPackage) || typeof installedPackage.version !== "string") {
          failures.push(`lockfile does not describe audited node ${node}`);
        } else if (!advisory.allowedInstalledVersions.includes(installedPackage.version)) {
          failures.push(
            `advisory source ${source} has unreviewed installed version ${installedPackage.version}`,
          );
        }
      }
    }
  }

  if (failures.length > 0) {
    return { _tag: "Rejected", reasons: failures };
  }

  return {
    _tag: "Accepted",
    message: `Dependency audit accepted ${currentEntries.length} reviewed package findings covered by ${observedAdvisories.size} current advisories; policy expires ${policy.expiresAt}.`,
  };
}
