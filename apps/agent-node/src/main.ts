import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { createSocket } from "node:dgram";
import { CommandResult, HeartbeatPayload, stripWireNulls } from "@it-sentinel/contracts";
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
// 60s is only a fallback for a hand-rolled .env. install-sentinel-agent.ps1
// writes HEARTBEAT_INTERVAL_MS=15000, so every enrolled machine reports every
// 15 seconds - the figure the enrollment page and the runbook both quote.
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 60_000);
const COMMAND_POLL_INTERVAL_MS = Number(process.env.COMMAND_POLL_INTERVAL_MS ?? 5_000);
const COLLECT_TIMEOUT_MS = Number(process.env.COLLECT_TIMEOUT_MS ?? 45_000);
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
 * Address ranges that belong to virtual adapters rather than the network the
 * relay lives on. 192.168.56.0/24 is VirtualBox's host-only default and is
 * the one that actually bit us: it sorts before a real 10.x address, is not
 * "internal" as far as Node is concerned, and its adapter is often just
 * named "Ethernet 2" — so neither ordering nor the name filter caught it,
 * and the agent published an address the relay could never reach.
 */
const VIRTUAL_RANGES = [
  /^192\.168\.56\./, // VirtualBox host-only, the default and the one that bit us
  /^192\.168\.99\./, // docker-machine / minikube
  /^172\.17\./, // docker0, Docker's default bridge specifically
  /^169\.254\./, // APIPA: no DHCP answered, routes nowhere
];

// Deliberately NOT blocked: the rest of 172.16.0.0/12. An earlier version
// excluded 172.16-172.31 wholesale to catch Docker networks and thereby
// rejected 172.20.10.x — which is the iPhone personal-hotspot range, i.e.
// exactly the network this fleet runs on. RFC1918 says that whole block is
// ordinary private space; only Docker's own default bridge is predictable
// enough to name. Guessing "virtual" from a prefix is what the routing probe
// exists to avoid, so the blocklist stays small and the router decides.

function nameLooksVirtual(name: string): boolean {
  return /vEthernet|Loopback|VirtualBox|VMware|Hyper-V|Docker|WSL|TAP|Tailscale|ZeroTier/i.test(name);
}

/**
 * The address the OS would actually source from when talking to the control
 * plane.
 *
 * Asking the routing table beats ranking `networkInterfaces()` by hand,
 * because it answers the question we actually care about — "which of this
 * machine's addresses is on the network that carries real traffic" — instead
 * of guessing from names and prefixes we have to keep extending. A connected
 * UDP socket sends nothing; it only makes the kernel pick a route, so this
 * costs nothing and needs no reachable peer.
 */
async function routedIpv4(target: string): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    const finish = (v: string | null) => {
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 1500);
    sock.once("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    try {
      sock.connect(53, target, () => {
        clearTimeout(timer);
        const addr = sock.address().address;
        finish(addr && addr !== "0.0.0.0" ? addr : null);
      });
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

/** Enumeration fallback for when the routing probe cannot answer. */
function enumeratedIpv4(): string[] {
  const candidates: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (nameLooksVirtual(name)) continue;
      if (VIRTUAL_RANGES.some((r) => r.test(addr.address))) continue;
      candidates.push(addr.address);
    }
  }
  return candidates;
}

async function resolveHostIp(): Promise<string> {
  const override = process.env.SENTINEL_HOST_IP;
  if (override) return override;

  // 8.8.8.8 is a routing hint, not a dependency — nothing is sent to it, and
  // the kernel answers even with the network unplugged from the internet.
  const routed = (await routedIpv4("8.8.8.8")) ?? (await routedIpv4("1.1.1.1"));
  const enumerated = enumeratedIpv4();

  if (routed && !VIRTUAL_RANGES.some((r) => r.test(routed))) return routed;

  if (enumerated.length > 0) {
    if (enumerated.length > 1) {
      console.warn(
        `[agent-node] several plausible addresses (${enumerated.join(", ")}); using ${enumerated[0]}. Set SENTINEL_HOST_IP to override.`,
      );
    }
    return enumerated[0]!;
  }

  // Routed but virtual, and nothing better: report it and say so, because a
  // wrong address here fails later as "remote desktop just spins" rather
  // than as anything that points back here.
  if (routed) {
    console.warn(`[agent-node] only a virtual-looking address is routable (${routed}); remote desktop may fail. Set SENTINEL_HOST_IP.`);
    return routed;
  }

  console.warn("[agent-node] no usable IPv4 found — remote sessions to this machine will fail. Set SENTINEL_HOST_IP.");
  return "0.0.0.0";
}

/**
 * The machine's LAN address, resolved once at startup. The relay dials this
 * to reach TightVNC, so getting it wrong means remote desktop never connects
 * and there is nothing in the failure that points back here.
 */
let HOST_IP = "0.0.0.0";

async function runCollectScript(): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await execFileAsync("pwsh", ["-NoProfile", "-NonInteractive", "-File", COLLECT_SCRIPT], {
      // 45s, not 20s. A real collection on a cold machine measured 24s: the
      // Windows Update COM search alone is ~8s, and the port probe used to
      // add another ~7s. The old ceiling killed the script mid-run on every
      // heartbeat, and because a killed process writes no stderr the failure
      // looked like the collector producing nothing for no reason.
      //
      // The heartbeat loop awaits this before sleeping, so a slow collection
      // stretches the interval rather than overlapping runs.
      timeout: COLLECT_TIMEOUT_MS,
    });
    const trimmed = stdout.trim();
    return trimmed ? JSON.parse(trimmed) : null;
  } catch (err) {
    // execFile's Error.message is just the command line — it drops the
    // script's own stderr, which is the only part that says WHY. Reporting
    // "Command failed: pwsh -File collect.ps1" and nothing else sent us
    // debugging blind once already.
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string; code?: unknown };

    if (e.code === "ENOENT") {
      console.error(
        "[agent-node] pwsh not found. The collector needs PowerShell 7, not Windows PowerShell 5.1.\n" +
          "  Install it:  winget install -e --id Microsoft.PowerShell --source winget\n" +
          "  Then open a NEW terminal — PATH is not refreshed in this one — and start the agent again.",
      );
      return null;
    }

    // execFile reports a timeout kill as killed/SIGTERM with empty output,
    // which is indistinguishable from a broken script unless it is named.
    if ((e as { killed?: boolean }).killed) {
      console.error(
        `[agent-node] collect.ps1 exceeded ${COLLECT_TIMEOUT_MS / 1000}s and was killed. ` +
          "Raise COLLECT_TIMEOUT_MS if this machine is genuinely slow.",
      );
      return null;
    }

    const stderr = (e.stderr ?? "").trim();
    const stdout = (e.stdout ?? "").trim();
    console.error("[agent-node] collect.ps1 failed:", e.message);
    if (stderr) console.error("[agent-node] collect.ps1 stderr:\n" + stderr.slice(0, 2000));
    // A non-JSON stdout usually means the script emitted a warning or a
    // prompt before its payload, which is worth seeing in full.
    else if (stdout) console.error("[agent-node] collect.ps1 stdout (not JSON):\n" + stdout.slice(0, 800));
    else console.error("[agent-node] collect.ps1 produced no output at all.");
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

  // PowerShell emits null for every absent value; the contract's optional
  // fields accept a missing key but not an explicit null.
  const parsed = HeartbeatPayload.safeParse(stripWireNulls(candidate));
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

async function main() {
  // Resolved before the first heartbeat, not lazily: the address is part of
  // the very first payload, and an asset provisioned with the wrong one keeps
  // it until something overwrites it.
  HOST_IP = await resolveHostIp();
  console.log(
    `[agent-node] starting for branch ${BRANCH_NAME} (${BRANCH_SLUG}) as ${HOST_IP}, control plane ${CONTROL_PLANE_URL}`,
  );
  void heartbeatLoop();
  void commandPollLoop();
}

void main();
