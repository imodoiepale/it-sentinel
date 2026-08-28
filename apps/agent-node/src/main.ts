import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { CommandResult, HeartbeatPayload } from "@it-sentinel/contracts";
import { executeCommand, runPowerShellReal, type ExecutorDeps, type ScriptManifest } from "./exec/executor.js";

/**
 * agent-node's entrypoint. Installed as a Windows Service running as
 * LocalSystem (node-windows in production packaging — see the plan's
 * Elevated execution model). Two independent loops:
 *   1. Heartbeat: runs collect.ps1 locally every 60s, posts to
 *      /v1/heartbeat — identical wire shape to agent-less and agent-dotnet.
 *   2. Command poll: long-polls /v1/commands/poll for queued work, and the
 *      ONLY thing it does with what it gets back is hand it to
 *      executeCommand() in exec/executor.ts — nothing here bypasses that
 *      gate, ever.
 */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const COLLECT_SCRIPT = join(__dirname, "collect.ps1");
const SCRIPTS_DIR = process.env.SENTINEL_SCRIPTS_DIR ?? join(__dirname, "..", "..", "..", "packages", "scripts", "library");

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? "http://localhost:8787";
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 60_000);
const COMMAND_POLL_INTERVAL_MS = Number(process.env.COMMAND_POLL_INTERVAL_MS ?? 5_000);
const BRANCH_SLUG = process.env.SENTINEL_BRANCH_SLUG;
const BRANCH_NAME = process.env.SENTINEL_BRANCH_NAME;

if (!BRANCH_SLUG || !BRANCH_NAME) {
  console.error("[agent-node] SENTINEL_BRANCH_SLUG and SENTINEL_BRANCH_NAME must be set — this agent needs to know which branch it belongs to");
  process.exit(1);
}

/**
 * This agent's asset id, learned from the first successful heartbeat —
 * /v1/heartbeat returns { assetId, status } after auto-provisioning (see
 * ingest.service.ts). It is what the command poll filters on, so the poll
 * loop stays idle until a heartbeat has landed: polling without it would
 * mean asking for "anyone's work", which is exactly the cross-machine
 * mis-execution that migration 0025 removes.
 */
let myAssetId: string | null = null;

/**
 * The machine's LAN address. The relay dials this to reach TightVNC, so
 * "0.0.0.0" (what this used to send) meant remote sessions could never
 * connect. Picks the first non-internal IPv4 — on a laptop with both Wi-Fi
 * and a virtual adapter (Docker/WSL/VirtualBox) that can pick wrong, so
 * SENTINEL_HOST_IP overrides it.
 */
function primaryIpv4(): string {
  const override = process.env.SENTINEL_HOST_IP;
  if (override) return override;

  const candidates: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      // Deprioritise well-known virtual adapters — they are routable from
      // this host but not from the relay.
      if (/^(vEthernet|Loopback|VirtualBox|VMware|Docker|WSL)/i.test(name)) continue;
      candidates.push(addr.address);
    }
  }
  if (candidates.length === 0) {
    console.warn("[agent-node] no non-internal IPv4 found — remote sessions to this machine will fail. Set SENTINEL_HOST_IP.");
    return "0.0.0.0";
  }
  if (candidates.length > 1) {
    console.warn(`[agent-node] multiple IPv4 addresses (${candidates.join(", ")}); using ${candidates[0]}. Set SENTINEL_HOST_IP to override.`);
  }
  return candidates[0]!;
}

const HOST_IP = primaryIpv4();

async function runCollectScript(): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await execFileAsync("pwsh", ["-NoProfile", "-NonInteractive", "-File", COLLECT_SCRIPT], {
      timeout: 20_000,
    });
    const trimmed = stdout.trim();
    return trimmed ? JSON.parse(trimmed) : null;
  } catch (err) {
    console.error("[agent-node] collect.ps1 failed:", (err as Error).message);
    return null;
  }
}

function toHeartbeat(detail: Record<string, unknown>): HeartbeatPayload | null {
  const now = new Date().toISOString();
  const hostname = (detail.hostname as string) ?? process.env.COMPUTERNAME ?? "unknown-host";
  const printers = (detail.printers as any[]) ?? [];
  const anyPrinterFault = printers.some((p) => !p.online);
  const security = detail.security as any;
  const network = detail.network as any;
  const enquestDetail = detail.enquestDetail as any;
  const emailDetail = detail.emailDetail as any;
  const ram = detail.ram as any;
  const storage = detail.storage as any;
  const primaryVolume = (storage?.volumes as any[])?.[0];

  const candidate = {
    schemaVersion: 1 as const,
    collector: "agent-node" as const,
    collectedAt: now,
    branch: BRANCH_NAME,
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
      branchSlug: BRANCH_SLUG,
      ip: HOST_IP,
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
    console.error("[agent-node] heartbeat failed contract validation:", parsed.error.issues);
    return null;
  }
  return parsed.data;
}

async function heartbeatLoop() {
  for (;;) {
    const detail = await runCollectScript();
    if (detail) {
      const hb = toHeartbeat(detail);
      if (hb) {
        const res = await fetch(`${CONTROL_PLANE_URL}/v1/heartbeat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(hb),
        }).catch((err) => {
          console.error("[agent-node] heartbeat POST failed:", err.message);
          return null;
        });
        if (res && !res.ok) {
          console.error(`[agent-node] heartbeat rejected: ${res.status}`);
        } else if (res) {
          // The response carries this machine's asset id (auto-provisioned on
          // first contact). Capturing it is what unlocks the command poll.
          const body = (await res.json().catch(() => null)) as { assetId?: string } | null;
          if (body?.assetId && body.assetId !== myAssetId) {
            myAssetId = body.assetId;
            console.log(`[agent-node] identified as asset ${myAssetId} (${HOST_IP})`);
          }
        }
      }
    }
    await new Promise((r) => setTimeout(r, HEARTBEAT_INTERVAL_MS));
  }
}

const execDeps: ExecutorDeps = {
  loadScriptManifest: async (scriptId) => {
    try {
      const manifestPath = join(SCRIPTS_DIR, `${scriptId}.manifest.json`);
      const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
      return { scriptId, sha256: raw.sha256, path: join(SCRIPTS_DIR, raw.scriptPath), tier: raw.tier } satisfies ScriptManifest;
    } catch {
      return null;
    }
  },
  readScriptContent: async (path) => readFileSync(path),
  runPowerShell: runPowerShellReal,
  auditRefusal: async (request, reason) => {
    // Reported to the control plane's own audit_log via the command-result
    // path below (outcome=refused carries refusalReason) — this hook exists
    // so a future local security-event log can also capture it offline if
    // the branch is disconnected from the control plane at refusal time.
    console.warn(`[agent-node] REFUSED command ${request.commandId}: ${reason}`);
  },
};

async function commandPollLoop() {
  for (;;) {
    try {
      // Idle until the first heartbeat tells us who we are. Polling without
      // an asset id would fetch other machines' commands.
      if (!myAssetId) {
        await new Promise((r) => setTimeout(r, COMMAND_POLL_INTERVAL_MS));
        continue;
      }
      const res = await fetch(`${CONTROL_PLANE_URL}/v1/commands/poll?assetId=${encodeURIComponent(myAssetId)}`);
      if (res.ok) {
        const { messages } = (await res.json()) as { messages: { msg_id: number; message: unknown }[] };
        for (const msg of messages) {
          const result: CommandResult = await executeCommand(msg.message as any, execDeps);
          await fetch(`${CONTROL_PLANE_URL}/v1/commands/${msg.msg_id}/result`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(result),
          }).catch((err) => console.error("[agent-node] failed to report command result:", err.message));
        }
      }
    } catch (err) {
      console.error("[agent-node] command poll failed:", (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, COMMAND_POLL_INTERVAL_MS));
  }
}

console.log(`[agent-node] starting for branch ${BRANCH_NAME} (${BRANCH_SLUG}), control plane ${CONTROL_PLANE_URL}`);
void heartbeatLoop();
void commandPollLoop();
