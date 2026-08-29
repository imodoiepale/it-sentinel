import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The enrollment routes are the only part of this service that reads files
 * off the server's disk and hands them to an unauthenticated caller, so the
 * property that matters most here is the one a code review cannot prove by
 * inspection alone: that no request can name a file the allowlist does not
 * contain. A traversal on this route reads whatever the process can read,
 * .env included.
 *
 * The rest of the tests cover what a laptop standing at a PowerShell prompt
 * actually depends on: the scripts come back as text rather than JSON, the
 * archive is a well-formed zip, and it does not contain the two things it
 * must never contain (node_modules, and any .env).
 *
 * Routed through Fastify's inject() rather than by calling the handlers
 * directly, because path decoding happens in the router and that is exactly
 * the layer the traversal tests are about.
 */

const state = vi.hoisted(() => ({
  sites: [
    { name: "Nairobi HQ", slug: "nairobi-hq", region: "Africa", criticality: "critical" },
    { name: "Lagos", slug: "lagos", region: "Africa", criticality: "standard" },
    { name: "Dubai", slug: "dubai", region: "Middle East", criticality: "standard" },
    { name: "London", slug: "london", region: "Europe", criticality: "standard" },
    { name: "Singapore", slug: "singapore", region: "APAC", criticality: "standard" },
    { name: "Sao Paulo", slug: "sao-paulo", region: "LATAM", criticality: "standard" },
    { name: "New York", slug: "new-york", region: "Americas", criticality: "critical" },
  ] as any[],
  sitesError: null as any,
}));

vi.mock("../src/db.js", () => {
  function table() {
    const chain: any = {
      select: () => chain,
      in: async () => ({ data: state.sitesError ? null : state.sites, error: state.sitesError }),
    };
    return chain;
  }
  return { db: { from: () => table() } };
});

const { registerEnrollRoutes } = await import("../src/enroll/enroll.routes.js");

function buildApp() {
  const app = Fastify();
  registerEnrollRoutes(app);
  return app;
}

async function get(url: string) {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url });
  await app.close();
  return res;
}

/**
 * Reads entry names out of a zip by walking its central directory, rather
 * than trusting the local headers. Doing it the way a real extractor does
 * is the point: if the central directory offsets or the entry count were
 * wrong, Expand-Archive would fail on a branch laptop and this would pass.
 */
function zipEntryNames(buf: Buffer): string[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(-1);

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const names: string[] = [];

  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(offset)).toBe(0x02014b50);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    names.push(buf.toString("utf-8", offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

beforeEach(() => {
  state.sitesError = null;
});

describe("GET /v1/enroll/:file", () => {
  const ALLOWED = [
    "bootstrap.ps1",
    "install-sentinel-agent.ps1",
    "preflight.ps1",
    "uninstall-sentinel-agent.ps1",
  ];

  for (const name of ALLOWED) {
    it(`serves ${name} as text a PowerShell pipeline can execute`, async () => {
      const res = await get(`/v1/enroll/${name}`);
      expect(res.statusCode).toBe(200);
      // Not application/json: Invoke-RestMethod parses by content type, and
      // `irm ... | iex` needs a string.
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.body.length).toBeGreaterThan(500);
      expect(res.body).toContain("IT Sentinel");
    });
  }

  /**
   * Every one of these is a real shape an attacker would try. They are
   * refused because the route matches the parameter against a Set and then
   * joins the CONSTANT onto the path — the caller's string never reaches
   * the filesystem — so the answer is the same 404 whatever the encoding.
   */
  const TRAVERSALS = [
    "..%2f..%2f.env",
    "..%2F..%2Fapps%2Fcontrol-plane%2F.env",
    "%2e%2e%2f%2e%2e%2f.env",
    "....%2f%2f....%2f%2f.env",
    ".env",
    "C:%5CWindows%5Cwin.ini",
    "%2Fetc%2Fpasswd",
    "bootstrap.ps1%00.env",
    "bootstrap.ps1.",
    "BOOTSTRAP.PS1",
  ];

  for (const attempt of TRAVERSALS) {
    it(`refuses ${attempt}`, async () => {
      const res = await get(`/v1/enroll/${attempt}`);
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("unknown_script");
    });
  }

  it("refuses an un-encoded traversal too", async () => {
    // The client normalises this before the router sees it, so the useful
    // assertion is only that nothing is served — which is what matters.
    const res = await get("/v1/enroll/../../../../etc/passwd");
    expect(res.statusCode).toBe(404);
  });

  it("does not serve a script that exists but is not on the allowlist", async () => {
    // scripts/preflight.ps1 is servable; scripts/simulate-fault.ps1 is a
    // real file in the same directory and must not be.
    const res = await get("/v1/enroll/simulate-fault.ps1");
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("unknown_script");
  });
});

describe("GET /v1/enroll/branches", () => {
  it("returns exactly the slugs install-sentinel-agent.ps1 accepts", async () => {
    const res = await get("/v1/enroll/branches");
    expect(res.statusCode).toBe(200);

    const { branches, source } = res.json();
    expect(source).toBe("database");
    expect(branches.map((b: any) => b.slug)).toEqual([
      "nairobi-hq",
      "lagos",
      "dubai",
      "london",
      "singapore",
      "sao-paulo",
      "new-york",
    ]);
    expect(branches[1]).toMatchObject({ slug: "lagos", name: "Lagos", region: "Africa" });
  });

  it("still answers when the database is down", async () => {
    // A blip in Supabase should not be the reason nobody can enroll a
    // machine: the slugs are a constant in this process either way.
    state.sitesError = { message: "connection refused" };
    const res = await get("/v1/enroll/branches");

    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe("fallback");
    expect(res.json().branches).toHaveLength(7);
  });
});

describe("GET /v1/enroll/repo.zip", () => {
  it("serves a well-formed zip carrying the installer and the agent", async () => {
    const res = await get("/v1/enroll/repo.zip");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");

    const buf = res.rawPayload;
    expect(buf.subarray(0, 2).toString()).toBe("PK");

    const names = zipEntryNames(buf);
    expect(names).toContain("scripts/install-sentinel-agent.ps1");
    expect(names).toContain("apps/agent-node/src/main.ts");
    expect(names).toContain("packages/contracts/package.json");
    // pnpm needs the workspace root to resolve the agent the same way we do.
    expect(names).toContain("pnpm-workspace.yaml");
    expect(names).toContain("pnpm-lock.yaml");
  });

  it("never ships secrets or installed dependencies", async () => {
    const names = zipEntryNames((await get("/v1/enroll/repo.zip")).rawPayload);

    // apps/agent-node/.env exists in a working checkout and holds this
    // machine's real hub credentials. Shipping it would hand them to
    // everyone who enrolls.
    expect(names.filter((n) => /(^|\/)\.env$/.test(n))).toEqual([]);
    expect(names.filter((n) => /(^|\/)\.env\.local$/.test(n))).toEqual([]);
    expect(names.filter((n) => n.includes("node_modules/"))).toEqual([]);
    expect(names.filter((n) => n.includes(".git/"))).toEqual([]);

    // And nothing outside the allowlisted subtrees — the console source and
    // the database migrations have no business on a branch laptop.
    expect(names.filter((n) => n.startsWith("apps/web/"))).toEqual([]);
    expect(names.filter((n) => n.startsWith("packages/db/"))).toEqual([]);
    expect(names.filter((n) => n.startsWith("docs/"))).toEqual([]);
  });
});

describe("GET /v1/enroll/installer/:file", () => {
  it("serves SentinelSetup.cmd as a download rather than a page of text", async () => {
    const res = await get("/v1/enroll/installer/SentinelSetup.cmd");
    expect(res.statusCode).toBe(200);
    // Without this a browser renders the launcher inline and the person who
    // clicked "download" gets a wall of batch script and no file.
    expect(res.headers["content-disposition"]).toBe('attachment; filename="SentinelSetup.cmd"');
    expect(res.rawPayload.toString("utf-8")).toContain("IT SENTINEL");
  });

  /**
   * cmd.exe mis-parses `goto` labels and parenthesised blocks in a file with
   * bare LF endings, and SentinelSetup.cmd uses both. Render checks out on
   * Linux, where git may well have normalised the working tree to LF, so the
   * route normalises on the way out and this is the assertion that says so.
   */
  it("serves the .cmd with CRLF line endings whatever is on disk", async () => {
    const body = (await get("/v1/enroll/installer/SentinelSetup.cmd")).rawPayload.toString("utf-8");

    expect(body).toContain("\r\n");
    // No bare LF anywhere: every \n must be preceded by \r.
    expect(/(?<!\r)\n/.test(body)).toBe(false);
  });

  it("keeps the .cmd pure ASCII, so no console code page can mangle it", async () => {
    // A smart quote or an en-dash pasted into the launcher renders as
    // mojibake under any OEM code page but the author's. Asserted at the
    // route because that is the copy a teammate actually receives.
    const bytes = (await get("/v1/enroll/installer/SentinelSetup.cmd")).rawPayload;
    expect([...bytes].filter((b) => b > 127)).toEqual([]);
  });

  /**
   * Same discipline as the scripts route, exercised the same way: the
   * parameter is a Map key, never a path fragment, so no encoding of `..`
   * reaches the filesystem. This route is the more tempting target of the
   * two — it is the one that reads outside scripts/.
   */
  const TRAVERSALS = [
    "..%2f..%2f.env",
    "..%2F..%2Fscripts%2Fbootstrap.ps1",
    "%2e%2e%2f%2e%2e%2f.env",
    "....%2f%2f....%2f%2f.env",
    "..%2fSentinelSetup.cmd",
    ".env",
    "C:%5CWindows%5Cwin.ini",
    "%2Fetc%2Fpasswd",
    "SentinelSetup.cmd%00.env",
    "SentinelSetup.cmd.",
    "sentinelsetup.cmd",
    "build.ps1",
    "SentinelSetup.cs",
  ];

  for (const attempt of TRAVERSALS) {
    it(`refuses ${attempt}`, async () => {
      const res = await get(`/v1/enroll/installer/${attempt}`);
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("unknown_installer");
    });
  }

  it("refuses an un-encoded traversal too", async () => {
    const res = await get("/v1/enroll/installer/../../../../etc/passwd");
    expect(res.statusCode).toBe(404);
  });

  it("does not let the installer route reach a servable script", async () => {
    // bootstrap.ps1 is legitimately served by /v1/enroll/:file. It must not
    // also be reachable here, because "the allowlists happen to overlap" is
    // how a second directory quietly becomes servable.
    const res = await get("/v1/enroll/installer/bootstrap.ps1");
    expect(res.statusCode).toBe(404);
  });

  /**
   * SentinelSetup.exe is built by csc.exe on Windows and is deliberately not
   * committed, so a hosted deployment usually does not have it. Both answers
   * are correct; what must never happen is a bare 404 or an empty body that
   * leaves somebody thinking the download is broken.
   */
  it("either serves the .exe or explains where to go instead", async () => {
    const res = await get("/v1/enroll/installer/SentinelSetup.exe");

    if (res.statusCode === 200) {
      expect(res.headers["content-disposition"]).toBe('attachment; filename="SentinelSetup.exe"');
      // MZ. Serving a truncated or text-mangled binary is worse than
      // serving nothing, because the failure surfaces on the laptop.
      expect(res.rawPayload.subarray(0, 2).toString("latin1")).toBe("MZ");
      expect(res.rawPayload.length).toBeGreaterThan(4096);
    } else {
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.error).toBe("installer_unavailable");
      expect(body.alternatives.cmd).toContain("/v1/enroll/installer/SentinelSetup.cmd");
      expect(body.alternatives.oneLiner).toContain("| iex");
    }
  });
});

describe("GET /v1/enroll/installer/:file with no checkout to read", () => {
  // A repo root that satisfies locateRepoRoot's marker but has no installer/
  // in it — which is exactly the shape of a deployment that cannot serve the
  // launchers. Without this the 503 branch is untested on any machine that
  // has run installer\build.ps1.
  let root: string;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.SENTINEL_REPO_ROOT;
    root = mkdtempSync(join(tmpdir(), "sentinel-noinstaller-"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "bootstrap.ps1"), "# IT Sentinel\n");
    process.env.SENTINEL_REPO_ROOT = root;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.SENTINEL_REPO_ROOT;
    else process.env.SENTINEL_REPO_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });

  it("returns 503 naming the two things that do work", async () => {
    const res = await get("/v1/enroll/installer/SentinelSetup.cmd");
    expect(res.statusCode).toBe(503);

    const body = res.json();
    expect(body.error).toBe("installer_unavailable");
    // The point of the message: never a dead end.
    expect(body.message).toContain("SentinelSetup.cmd");
    expect(body.alternatives.oneLiner).toContain("/v1/enroll/bootstrap.ps1");
  });

  it("still refuses an unknown name rather than reporting it unavailable", async () => {
    // Allowlist first, disk second. Getting that order wrong would turn the
    // 503 into an oracle for which paths exist on the server.
    const res = await get("/v1/enroll/installer/.env");
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("unknown_installer");
  });
});

describe("GET /v1/enroll", () => {
  it("tells a browser what to do instead of returning a bare 404", async () => {
    const res = await get("/v1/enroll");
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.oneLiner).toContain("/v1/enroll/bootstrap.ps1");
    expect(body.oneLiner).toContain("| iex");
    expect(body.archive).toContain("/v1/enroll/repo.zip");
  });

  it("reports which launchers this deployment can actually serve", async () => {
    // The enrollment page reads this to decide whether to render the .exe
    // download at all, so `available` has to reflect the disk rather than
    // the allowlist.
    const body = (await get("/v1/enroll")).json();
    const byFile = new Map(body.installers.map((i: any) => [i.file, i]));

    expect(byFile.get("SentinelSetup.cmd")).toMatchObject({ available: true });
    expect((byFile.get("SentinelSetup.cmd") as any).url).toContain("/v1/enroll/installer/SentinelSetup.cmd");

    const exe = byFile.get("SentinelSetup.exe") as any;
    expect(exe.url).toContain("/v1/enroll/installer/SentinelSetup.exe");
    expect(exe.available).toBe(existsSync(join(process.cwd(), "..", "..", "installer", "dist", "SentinelSetup.exe")));
  });
});
