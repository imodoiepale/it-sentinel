import { deflateRawSync } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { locateRepoRoot } from "./repo-locator.js";

/**
 * The enrollment payload: a .zip of just enough of this repo for
 * scripts/install-sentinel-agent.ps1 to install and run the agent.
 *
 * Why an archive at all — the installer is not a standalone script. It runs
 * `pnpm install` at the repo root and starts the agent from source
 * (apps/agent-node), so handing a laptop only the four .ps1 files would put
 * it three steps into the install before it discovered there was nothing to
 * install. The alternative, `git clone`, is what bootstrap.ps1 used to do,
 * and it 404s for anyone not signed in to the private GitHub repo — which is
 * every teammate this enrollment page exists for.
 *
 * Why .zip and not .tar.gz — Expand-Archive ships with Windows PowerShell
 * 5.1 on every machine we will ever meet; tar.exe only arrived in Windows 10
 * 1803. Deflate costs us a CRC32 table and nothing else, since zlib is in
 * Node's standard library. No new dependency either way.
 *
 * Why an allowlist of subtrees rather than the whole checkout — the repo is
 * private, and a branch laptop needs the agent, not the console source, the
 * database migrations or the docs. Shipping the smallest thing that works
 * keeps this route from quietly becoming a public mirror of the repo.
 */

/** Top-level paths that go into the archive. Anything else is not shipped. */
const INCLUDE = [
  // The workspace root itself: pnpm needs all four to resolve the agent's
  // dependency graph the same way it is resolved here.
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "tsconfig.base.json",

  "apps/agent-node",
  // Imported by the agent as `@it-sentinel/contracts` and resolved straight
  // to src/ (see that package's "exports"), so there is no build step to
  // reproduce on the laptop.
  "packages/contracts",
  // The hash-pinned script library the executor runs. Without the manifests
  // every signed_script dispatch fails its hash check at the agent.
  "packages/scripts",
  "scripts",
];

/**
 * Never archived, wherever they appear. The first group mirrors .gitignore —
 * build output and installed dependencies are reproduced on the laptop, not
 * shipped to it. `.env` and `.env.local` are here because a working copy,
 * including the one Render checks out, can hold real credentials, and one
 * mistake there would hand a service-role key to anyone who fetched this URL.
 */
const EXCLUDE_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".git",
  ".turbo",
  "coverage",
  "bin",
  "obj",
  ".env",
  ".env.local",
  ".DS_Store",
]);

/** Refuse to build something absurd rather than exhaust the instance's memory. */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

interface Entry {
  /** Archive path, always forward-slashed — Expand-Archive mangles backslashes. */
  name: string;
  data: Buffer;
}

function collect(root: string, rel: string, out: Entry[], budget: { used: number }): void {
  const abs = join(root, rel);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return; // an INCLUDE path missing from this checkout is not fatal
  }

  if (stat.isDirectory()) {
    for (const child of readdirSync(abs)) {
      if (EXCLUDE_NAMES.has(child)) continue;
      collect(root, posix.join(rel, child), out, budget);
    }
    return;
  }

  if (!stat.isFile()) return;
  budget.used += stat.size;
  if (budget.used > MAX_TOTAL_BYTES) {
    throw new Error(`enrollment archive exceeded ${MAX_TOTAL_BYTES} bytes at ${rel}`);
  }
  out.push({ name: rel, data: readFileSync(abs) });
}

/**
 * Minimal ZIP writer: a deflated local record per file, then the central
 * directory, then the end-of-central-directory record. Every size is known
 * before its record is written, so there are no data descriptors and no
 * streaming flag — which is what keeps this to one readable function.
 */
function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  // A fixed DOS timestamp (1980-01-01 00:00) rather than each file's mtime:
  // the archive is cached and served to many machines, and a byte-for-byte
  // stable result is worth more here than per-file dates nobody reads.
  const DOS_TIME = 0;
  const DOS_DATE = 0x0021;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf-8");
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, name, compressed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0, 8); // flags
    dir.writeUInt16LE(8, 10); // deflate
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk number start
    dir.writeUInt16LE(0, 36); // internal attributes
    dir.writeUInt32LE(0, 38); // external attributes
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

/**
 * Built on the first request and kept, because the checkout cannot change
 * under a running process: Render redeploys rather than mutating the working
 * tree. `null` is a cached "this deployment has no repo to serve", so a
 * broken layout does not re-walk the disk on every hit.
 */
let cached: Buffer | null | undefined;

export function buildRepoArchive(): Buffer | null {
  if (cached !== undefined) return cached;

  const root = locateRepoRoot();
  if (!root) {
    console.warn("[enroll] repo root not found — /v1/enroll/repo.zip will 503. Set SENTINEL_REPO_ROOT.");
    cached = null;
    return cached;
  }

  const entries: Entry[] = [];
  const budget = { used: 0 };
  for (const path of INCLUDE) collect(root, path, entries, budget);

  if (entries.length === 0) {
    cached = null;
    return cached;
  }

  cached = zip(entries);
  console.log(`[enroll] repo archive built: ${entries.length} files, ${cached.length} bytes from ${root}`);
  return cached;
}
