import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HeartbeatPayload } from "@it-sentinel/contracts";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const COLLECT_SCRIPT = join(__dirname, "ps", "collect.ps1");

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? "http://localhost:8787";
const POLL_INTERVAL_MS = Number(process.env.AGENTLESS_POLL_INTERVAL_MS ?? 60_000);
const PS_TIMEOUT_MS = 20_000;

interface Site {
  id: string;
  name: string;
  slug: string;
  primary_ip: string | null;
  region: string;
  criticality: string;
}

/**
 * Fans out over WinRM/PS-remoting to every branch's primary_ip, running
 * the read-only collect.ps1 (apps/agent-less/src/ps/collect.ps1) and
 * posting the result through the exact same /v1/heartbeat path agent-node
 * and agent-dotnet use — the wire contract in packages/contracts is what
 * makes this collector interchangeable with the other two.
 */

async function fetchSites(): Promise<Site[]> {
  const res = await fetch(`${CONTROL_PLANE_URL}/v1/sites`);
  if (!res.ok) throw new Error(`failed to fetch sites: ${res.status}`);
  const body = (await res.json()) as { sites: Site[] };
  return body.sites.filter((s) => s.primary_ip);
}

/**
 * Runs collect.ps1 against a remote host over PS-remoting. Uses the
 * caller's own Windows credentials (the dedicated AD service account this
 * process runs as, per the plan) — no credential is ever passed on the
 * command line or read from this process's environment into the script.
 */
async function collectFromHost(ip: string): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await execFileAsync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$session = New-PSSession -ComputerName '${ip}' -ErrorAction Stop; ` +
          `try { Invoke-Command -Session $session -FilePath '${COLLECT_SCRIPT}' } ` +
          `finally { Remove-PSSession $session }`,
      ],
      { timeout: PS_TIMEOUT_MS },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch (err) {
    console.error(`[agent-less] collection failed for ${ip}:`, (err as Error).message);
    return null;
  }
}

function toHeartbeat(site: Site, detail: Record<string, unknown>): HeartbeatPayload | null {
  const now = new Date().toISOString();
  const hostname = (detail.hostname as string) ?? `${site.slug}-primary`;

  const printers = (detail.printers as any[]) ?? [];
  const anyPrinterFault = printers.some((p) => !p.online);
  const security = detail.security as any;
  const network = detail.network as any;
  const enquestDetail = detail.enquestDetail as any;
  const emailDetail = detail.emailDetail as any;
  const ram = detail.ram as any;
  const storage = detail.storage as any;
  const volumes = (storage?.volumes as any[]) ?? [];
  const primaryVolume = volumes[0];

  const candidate = {
    schemaVersion: 1 as const,
    collector: "agent-less" as const,
    collectedAt: now,
    branch: site.name,
    hostname,
    online: true,
    networkLatencyMs: network?.internetLatencyMs,
    ramUsage: ram?.usagePercent ?? 0,
    diskFreePercent: primaryVolume?.freePercent ?? 0,
    printer: printers.length === 0 ? "unknown" : anyPrinterFault ? "critical" : "healthy",
    email: emailDetail?.status ?? "unknown",
    endpointSecurity: security?.status ?? "unknown",
    tightvnc: (detail.tightVncDetail as any)?.serviceRunning ? "running" : "stopped",
    enquest: enquestDetail?.status ?? "unknown",
    lastSeen: now,
    machine: {
      hostname,
      branchSlug: site.slug,
      ip: site.primary_ip,
      assetType: "workstation" as const,
      serial: (detail.machine as any)?.serial,
      model: (detail.machine as any)?.model,
      manufacturer: (detail.machine as any)?.manufacturer,
    },
    cpu: detail.cpu,
    ram: detail.ram,
    storage: detail.storage,
    windows: detail.windows,
    network: detail.network,
    tightVncDetail: detail.tightVncDetail,
    security: detail.security,
    printers: detail.printers ?? [],
    emailDetail: detail.emailDetail,
    enquestDetail: detail.enquestDetail,
    services: detail.services ?? [],
    applications: [],
    updates: detail.updates,
    recentEvents: detail.recentEvents ?? [],
    user: detail.user,
  };

  const parsed = HeartbeatPayload.safeParse(candidate);
  if (!parsed.success) {
    console.error(`[agent-less] heartbeat for ${site.name} failed contract validation:`, parsed.error.issues);
    return null;
  }
  return parsed.data;
}

async function postHeartbeat(hb: HeartbeatPayload) {
  const res = await fetch(`${CONTROL_PLANE_URL}/v1/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(hb),
  });
  if (!res.ok) {
    console.error(`[agent-less] heartbeat rejected for ${hb.hostname}: ${res.status} ${await res.text()}`);
  }
}

async function runOneSweep() {
  const sites = await fetchSites();
  console.log(`[agent-less] sweeping ${sites.length} branches`);

  const results = await Promise.allSettled(
    sites.map(async (site) => {
      const detail = await collectFromHost(site.primary_ip as string);
      if (!detail) return;
      const hb = toHeartbeat(site, detail);
      if (!hb) return;
      await postHeartbeat(hb);
    }),
  );

  const ok = results.filter((r) => r.status === "fulfilled").length;
  console.log(`[agent-less] sweep complete: ${ok}/${sites.length} branches reachable`);
}

async function main() {
  console.log(`[agent-less] starting, polling every ${POLL_INTERVAL_MS}ms against ${CONTROL_PLANE_URL}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await runOneSweep().catch((err) => console.error("[agent-less] sweep error:", err));
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main();
