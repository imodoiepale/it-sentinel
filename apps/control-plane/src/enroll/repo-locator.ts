import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the checked-out repo is on disk, from the control plane's point of
 * view.
 *
 * Same problem — and deliberately the same shape of answer — as
 * locateLibrary() in ../scripts/script-registry.ts: this process runs from
 * `src/` under tsx locally and from `dist/` on Render, with a cwd that is
 * the repo root in one case and not guaranteed in the other. Walking up a
 * fixed number of directories only ever works for one of those, so we try
 * each plausible root and keep the first that actually contains the marker
 * we need.
 *
 * The marker is scripts/bootstrap.ps1 rather than package.json, because a
 * root without scripts/ is useless to enrollment even if it is a real repo.
 */
export function locateRepoRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.SENTINEL_REPO_ROOT,
    // src/enroll and dist/enroll sit at the same depth, so one climb covers
    // both: enroll -> src|dist -> control-plane -> apps -> root
    join(here, "..", "..", "..", ".."),
    // one deeper, in case a build ever nests output another level
    join(here, "..", "..", "..", "..", ".."),
    process.cwd(),
  ].filter((p): p is string => Boolean(p));

  return candidates.find((p) => existsSync(join(p, "scripts", "bootstrap.ps1"))) ?? null;
}
