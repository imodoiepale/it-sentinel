import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { locateRepoRoot } from "./repo-locator.js";
import { buildRepoArchive } from "./repo-archive.js";

/**
 * Self-service enrollment: everything a fresh laptop needs to join the
 * fleet, served from the control plane instead of from GitHub.
 *
 * The reason this file exists is narrow and worth stating plainly. The
 * documented one-liner used to be `irm <raw.githubusercontent…> | iex`
 * against imodoiepale/it-sentinel, and that repo is PRIVATE: an
 * unauthenticated laptop gets a 404 from the raw URL and a 404 from the
 * clone that bootstrap.ps1 then attempts. The control plane, meanwhile,
 * already has the checkout on disk and is already public. Serving the
 * scripts and a trimmed repo archive from here turns a two-account, two-
 * permission-system problem into one URL.
 *
 * Nothing here is authenticated, and that is a decision rather than an
 * oversight — see docs/19-enrollment.md. In short: these routes serve text
 * that every member of the team can already read, they contain no secret,
 * and the enrollment *page* (which is what a human uses) is behind operator
 * login. Putting a token in front of a URL that has to be pasteable into a
 * blank PowerShell window on a machine with nothing on it would buy very
 * little and cost the whole point of the exercise.
 */

/**
 * The only filenames this route will ever read off disk.
 *
 * An allowlist, not a sanitiser: the parameter is used as a Set membership
 * test and the matched *constant* is what gets joined onto the path, so no
 * caller-supplied string ever reaches the filesystem. That closes the entire
 * class — `..%2f..%2f.env`, `C:\Windows\win.ini`, a NUL-truncated name —
 * without anyone having to enumerate it. A traversal here would read
 * arbitrary files off the server, `.env` among them, so "clever escaping"
 * was never an acceptable second place.
 */
const SERVABLE_SCRIPTS = new Set([
  "bootstrap.ps1",
  "install-sentinel-agent.ps1",
  "preflight.ps1",
  "uninstall-sentinel-agent.ps1",
]);

/**
 * The double-clickable launchers, for people who would rather not paste a
 * command into PowerShell. Both do the same thing the one-liner does: fetch
 * bootstrap.ps1 from here and run it. Neither makes a decision about the
 * machine — install-sentinel-agent.ps1 still shows its disclosure and still
 * waits for a typed INSTALL. See installer/README.md.
 *
 * Same allowlist discipline as SERVABLE_SCRIPTS, and for the same reason:
 * the key is a Set-membership test and the matched *constant* is what gets
 * joined onto the path, so no caller-supplied string reaches the filesystem.
 * These live outside scripts/, which is precisely why they get their own map
 * with the relative path spelled out rather than a second directory the
 * `:file` route could be pointed at.
 */
interface InstallerArtifact {
  /** Repo-relative path. A constant — never assembled from request input. */
  readonly path: string;
  readonly contentType: string;
  /**
   * Text artifacts are re-line-ended to CRLF on the way out (see
   * readInstallerArtifact). Binaries are served byte-for-byte.
   */
  readonly text: boolean;
  readonly description: string;
}

const SERVABLE_INSTALLER_ARTIFACTS = new Map<string, InstallerArtifact>([
  [
    "SentinelSetup.cmd",
    {
      path: "installer/SentinelSetup.cmd",
      contentType: "application/octet-stream",
      text: true,
      description: "Double-click launcher. Plain text, readable in Notepad, no compiler needed.",
    },
  ],
  [
    "SentinelSetup.exe",
    {
      path: "installer/dist/SentinelSetup.exe",
      contentType: "application/octet-stream",
      text: false,
      description: "Double-click launcher, compiled. Unsigned, so downloading it trips SmartScreen.",
    },
  ],
]);

/**
 * Absolute path of one allowlisted launcher, or `null` if this deployment
 * has no checkout to read from.
 *
 * `artifact.path` is a module constant, so this join cannot escape the repo.
 * The check below is kept explicit rather than clever so the next person
 * adding an entry to SERVABLE_INSTALLER_ARTIFACTS can see that the value has
 * to stay a literal.
 */
function locateInstallerArtifact(artifact: InstallerArtifact): string | null {
  const root = locateRepoRoot();
  if (!root) return null;

  const path = resolve(root, ...artifact.path.split("/"));
  if (!path.startsWith(resolve(root) + sep)) return null;
  return path;
}

/**
 * Whether this deployment can serve a launcher at all.
 *
 * A stat rather than a read, because the index route asks this for every
 * artifact on every request and reading a 28 KB binary to answer a boolean
 * is not a thing to do per request. For the .exe the answer is normally
 * `false` on a hosted deployment, and that is the expected state rather than
 * a fault — see installer/README.md for why the binary is not committed.
 */
function installerArtifactExists(artifact: InstallerArtifact): boolean {
  const path = locateInstallerArtifact(artifact);
  return path !== null && existsSync(path);
}

/** Reads one allowlisted launcher. `null` means it is not on this disk. */
function readInstallerArtifact(artifact: InstallerArtifact): Buffer | null {
  const path = locateInstallerArtifact(artifact);
  if (path === null) return null;

  try {
    const bytes = readFileSync(path);
    if (!artifact.text) return bytes;

    /**
     * CRLF, unconditionally.
     *
     * A .cmd with bare LF endings is a genuine hazard rather than a
     * cosmetic one: cmd.exe tolerates it for simple lines but mis-parses
     * `goto` labels and parenthesised blocks, both of which this file uses.
     * Render checks the repo out on Linux, and git is entitled to normalise
     * line endings in the working tree on the way there, so what is on disk
     * at serve time is not something this route can assume. Normalising here
     * costs one pass over five kilobytes and removes the whole question.
     */
    return Buffer.from(bytes.toString("utf-8").replace(/\r?\n/g, "\r\n"), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Branches a laptop may enroll into.
 *
 * Deliberately a copy of the `$Branches` list in
 * scripts/install-sentinel-agent.ps1, which hard-rejects any other slug and
 * exits. Offering a branch the installer refuses would let this page hand a
 * teammate a command that cannot work, so the two lists have to agree —
 * both trace back to packages/db/seed/003_bootstrap_demo.sql.
 */
const ENROLLABLE_SLUGS = [
  "nairobi-hq",
  "lagos",
  "dubai",
  "london",
  "singapore",
  "sao-paulo",
  "new-york",
] as const;

/** Names for ENROLLABLE_SLUGS when the database cannot be reached. */
const FALLBACK_NAMES: Record<string, string> = {
  "nairobi-hq": "Nairobi HQ",
  lagos: "Lagos",
  dubai: "Dubai",
  london: "London",
  singapore: "Singapore",
  "sao-paulo": "Sao Paulo",
  "new-york": "New York",
};

export interface EnrollBranch {
  slug: string;
  name: string;
  region: string | null;
  criticality: string | null;
}

function fallbackBranches(): EnrollBranch[] {
  return ENROLLABLE_SLUGS.map((slug) => ({
    slug,
    name: FALLBACK_NAMES[slug] ?? slug,
    region: null,
    criticality: null,
  }));
}

/**
 * Reads one allowlisted script. Returns null when the deployment has no
 * checkout to read from, which the caller turns into a 503 rather than a
 * 404 — "this server is misconfigured" and "no such script" are different
 * problems and send whoever is standing at the laptop in different
 * directions.
 */
function readScript(name: string): string | null {
  const root = locateRepoRoot();
  if (!root) return null;

  const dir = resolve(root, "scripts");
  const path = resolve(join(dir, name));

  // Defence in depth. SERVABLE_SCRIPTS already makes this unreachable; it
  // stays because the cost is one comparison and the failure mode of the
  // allowlist ever being loosened is reading the server's secrets.
  if (path !== join(dir, name) || !path.startsWith(dir + sep)) return null;

  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Where a laptop should fetch from. Behind Render's proxy `request.protocol`
 * reports the internal hop rather than the public scheme, so the public URL
 * is taken from configuration first and only guessed from the Host header as
 * a fallback (https, because anything reaching this in production did).
 */
function publicBaseUrl(hostname: string): string {
  return process.env.CONTROL_PLANE_PUBLIC_URL ?? `https://${hostname}`;
}

export function registerEnrollRoutes(app: FastifyInstance): void {
  /**
   * Self-describing index, in the same spirit as the `/` route in main.ts:
   * anyone who pastes this URL into a browser should learn what to do next
   * instead of reading Fastify's bare 404.
   */
  app.get("/v1/enroll", async (request, reply) => {
    // headers.host rather than request.hostname: Fastify strips the port,
    // and a local hub on :8787 needs it in the URL it prints.
    const base = publicBaseUrl(request.headers.host ?? request.hostname);
    return reply.code(200).send({
      service: "it-sentinel-enrollment",
      status: "ok",
      console: `${process.env.CONSOLE_URL ?? "https://it-sentinel-web.onrender.com"}/enroll`,
      oneLiner: `irm ${base}/v1/enroll/bootstrap.ps1 | iex`,
      scripts: [...SERVABLE_SCRIPTS].map((name) => `${base}/v1/enroll/${name}`),
      archive: `${base}/v1/enroll/repo.zip`,
      branches: `${base}/v1/enroll/branches`,
      // `available` is checked on every request rather than cached, because
      // the .exe is the one artifact a deployment may legitimately not have
      // (see readInstallerArtifact) and the enrollment page uses this to
      // decide whether to offer the download at all. Offering a button that
      // 503s is worse than not offering it.
      installers: [...SERVABLE_INSTALLER_ARTIFACTS].map(([name, artifact]) => ({
        file: name,
        url: `${base}/v1/enroll/installer/${name}`,
        description: artifact.description,
        available: installerArtifactExists(artifact),
      })),
    });
  });

  /**
   * The branch picker's data source. Exists so the enrollment page does not
   * need its own Supabase query — and, more usefully, so the page cannot
   * offer a slug the installer will reject.
   */
  app.get("/v1/enroll/branches", async (_request, reply) => {
    const { data, error } = await db
      .from("sites")
      .select("name, slug, region, criticality")
      .in("slug", [...ENROLLABLE_SLUGS]);

    if (error || !data || data.length === 0) {
      // Falling back rather than 500ing: the slugs are a compile-time
      // constant here anyway, and a database blip should not be the reason
      // nobody can enroll a machine.
      return reply.code(200).send({ branches: fallbackBranches(), source: "fallback" });
    }

    const bySlug = new Map(data.map((row: any) => [row.slug, row]));
    const branches: EnrollBranch[] = ENROLLABLE_SLUGS.map((slug) => {
      const row = bySlug.get(slug);
      return {
        slug,
        name: row?.name ?? FALLBACK_NAMES[slug] ?? slug,
        region: row?.region ?? null,
        criticality: row?.criticality ?? null,
      };
    });

    return reply.code(200).send({ branches, source: "database" });
  });

  /**
   * The repo subset bootstrap.ps1 extracts. See repo-archive.ts for what is
   * in it and why it is not the whole checkout.
   */
  app.get("/v1/enroll/repo.zip", async (request, reply) => {
    let archive: Buffer | null;
    try {
      archive = buildRepoArchive();
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "internal_error" });
    }

    if (!archive) {
      return reply.code(503).send({
        error: "archive_unavailable",
        message: "This control plane has no repo checkout to serve. Set SENTINEL_REPO_ROOT.",
      });
    }

    return reply
      .code(200)
      .header("content-type", "application/zip")
      .header("content-disposition", 'attachment; filename="it-sentinel.zip"')
      .send(archive);
  });

  /**
   * The double-clickable launchers.
   *
   * Its own path segment rather than another entry on the `:file` route,
   * because these are not scripts/ and the one thing that route's allowlist
   * must never learn to do is point at a second directory.
   *
   * Always `Content-Disposition: attachment`: a browser that renders a .cmd
   * inline gives somebody a page of text with no obvious way to save it, and
   * one that decides to *run* a downloaded .exe on its own is a category of
   * surprise this route should not be capable of causing.
   */
  app.get<{ Params: { file: string } }>("/v1/enroll/installer/:file", async (request, reply) => {
    const name = request.params.file;
    const artifact = SERVABLE_INSTALLER_ARTIFACTS.get(name);

    if (!artifact) {
      return reply.code(404).send({
        error: "unknown_installer",
        message: `Not an enrollment launcher. Available: ${[...SERVABLE_INSTALLER_ARTIFACTS.keys()].join(", ")}`,
      });
    }

    const body = readInstallerArtifact(artifact);
    if (body === null) {
      const base = publicBaseUrl(request.headers.host ?? request.hostname);
      /**
       * 503 and not 404, and with a message aimed at whoever is standing at
       * the laptop rather than at the operator.
       *
       * For SentinelSetup.exe this is the ordinary state of a hosted
       * deployment: the binary is built by csc.exe on Windows and is not
       * committed (installer/README.md, §"Why the .exe is not in git"), and
       * Render builds on Linux, so it cannot be produced at deploy time
       * either. Rather than pretend, the route names the two things that DO
       * work here and are equivalent in every way that matters.
       */
      return reply.code(503).send({
        error: "installer_unavailable",
        message:
          `${name} is not available from this control plane. ` +
          `Use ${base}/v1/enroll/installer/SentinelSetup.cmd, which does the same job, ` +
          `or paste the one-liner: irm ${base}/v1/enroll/bootstrap.ps1 | iex`,
        alternatives: {
          cmd: `${base}/v1/enroll/installer/SentinelSetup.cmd`,
          oneLiner: `irm ${base}/v1/enroll/bootstrap.ps1 | iex`,
        },
      });
    }

    return reply
      .code(200)
      .header("content-type", artifact.contentType)
      .header("content-disposition", `attachment; filename="${name}"`)
      // Nothing here is per-user and the file only changes on a redeploy,
      // but a stale launcher pointed at a decommissioned hub is a bad hour
      // for somebody, so this is deliberately short rather than immutable.
      .header("cache-control", "public, max-age=300")
      .send(body);
  });

  /**
   * The scripts themselves, as text/plain so that `irm … | iex` gets a
   * string rather than something Invoke-RestMethod tries to parse. The
   * download links on the enrollment page hit the same route.
   */
  app.get<{ Params: { file: string } }>("/v1/enroll/:file", async (request, reply) => {
    const name = request.params.file;

    if (!SERVABLE_SCRIPTS.has(name)) {
      return reply.code(404).send({
        error: "unknown_script",
        message: `Not an enrollment script. Available: ${[...SERVABLE_SCRIPTS].join(", ")}`,
      });
    }

    const body = readScript(name);
    if (body === null) {
      return reply.code(503).send({
        error: "script_unavailable",
        message: "This control plane has no repo checkout to serve. Set SENTINEL_REPO_ROOT.",
      });
    }

    return reply.code(200).header("content-type", "text/plain; charset=utf-8").send(body);
  });
}
