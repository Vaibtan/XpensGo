/** Reject any staged, unstaged, or untracked deployment input before provenance is stamped. */
export function assertDeployableStatus(porcelainStatus) {
  if (porcelainStatus.trim().length > 0) {
    throw new Error("Commit all staging deployment inputs before deploying.");
  }
}
