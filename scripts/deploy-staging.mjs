import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertDeployableStatus } from "./deploy-staging-policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gitSafeDirectory = repositoryRoot.replaceAll("\\", "/");
const executable = (name) => (process.platform === "win32" ? `${name}.cmd` : name);

function readGit(args) {
  const result = spawnSync("git", ["-c", `safe.directory=${gitSafeDirectory}`, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error("Unable to resolve deployment provenance from Git.");
  }
  return result.stdout.trim();
}

function assertCommittedDeploymentInputs() {
  const trackedInputs = [
    ".github",
    "apps",
    "packages",
    "scripts",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "turbo.json",
    "oxlint.json",
    "prettier.config.mjs",
    "compose.yaml",
  ];
  const status = readGit([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...trackedInputs,
  ]);
  assertDeployableStatus(status);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code ?? "unknown"}.`));
      }
    });
    if (options.input === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(options.input);
    }
  });
}

assertCommittedDeploymentInputs();
const revision = readGit(["rev-parse", "HEAD"]);
if (!/^[0-9a-f]{40}$/.test(revision)) {
  throw new Error("Git returned an invalid deployment revision.");
}

await run(executable("npm"), ["run", "deploy:staging", "--workspace=@xpensego/api"]);
await run(executable("npm"), ["run", "deploy:staging", "--workspace=@xpensego/web"]);
await run(executable("npx"), ["wrangler", "secret", "put", "BUILD_REVISION", "--env", "staging"], {
  cwd: path.join(repositoryRoot, "apps/api"),
  input: revision,
});
await run(executable("npx"), ["wrangler", "secret", "put", "BUILD_REVISION", "--env", "staging"], {
  cwd: path.join(repositoryRoot, "apps/web"),
  input: revision,
});

process.stdout.write(`Staging API and web Workers deployed from Git revision ${revision}.\n`);
