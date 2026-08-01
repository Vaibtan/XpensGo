import path from "node:path";

/** Reject any staged, unstaged, or untracked deployment input before provenance is stamped. */
export function assertDeployableStatus(porcelainStatus) {
  if (porcelainStatus.trim().length > 0) {
    throw new Error("Commit all staging deployment inputs before deploying.");
  }
}

/** Resolve npm launchers without asking Windows to execute a `.cmd` shim directly. */
export function resolvePackageCommand({ command, args, nodeExecutable, npmCliPath, platform }) {
  if (platform !== "win32") {
    return { command, args };
  }
  if (command !== "npm" && command !== "npx") {
    return { command, args };
  }
  if (npmCliPath === undefined || npmCliPath.length === 0) {
    throw new Error("npm did not expose its CLI path to the verified deployment script.");
  }

  const cliPath =
    command === "npm" ? npmCliPath : path.join(path.dirname(npmCliPath), "npx-cli.js");
  return { command: nodeExecutable, args: [cliPath, ...args] };
}
