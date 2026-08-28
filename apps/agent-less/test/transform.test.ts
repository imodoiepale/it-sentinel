import { describe, expect, it } from "vitest";
import { HeartbeatPayload } from "@it-sentinel/contracts";

// Mirrors toHeartbeat() in src/main.ts — kept as a standalone fixture test
// since main.ts runs an infinite poll loop and isn't meant to be imported.
// This proves the *shape* collect.ps1's JSON output must produce is
// actually assembleable into a contract-valid heartbeat.

const samplePsOutput = {
  hostname: "CW-JCT-PRIMARY",
  machine: { hostname: "CW-JCT-PRIMARY", serial: "SN123", model: "OptiPlex", manufacturer: "Dell" },
  cpu: { usagePercent: 18, coreCount: 4 },
  ram: { installedMb: 8192, availableMb: 3000, usagePercent: 63 },
  storage: { volumes: [{ drive: "C:", capacityMb: 250000, freeMb: 90000, freePercent: 36 }] },
  windows: { version: "Windows 10 Pro", build: "19045", activationStatus: "unknown", uptimeSeconds: 90000, rebootPending: false },
  network: { linkState: "lan", gatewayIp: "192.168.8.1", dnsServers: ["8.8.8.8"], internetReachable: true, internetLatencyMs: 22 },
  tightVncDetail: { installed: true, serviceRunning: true, portReachable: true },
  security: { serviceRunning: true, protectionEnabled: true, status: "healthy" },
  printers: [{ name: "HP LaserJet", isDefault: true, online: true, queueDepth: 0, faultClass: "none" }],
  emailDetail: { clientInstalled: true, profileConfigured: false, serverReachable: false, authOk: false, processRunning: true, status: "unknown" },
  enquestDetail: { installed: true, processRunning: true, databaseReachable: false, syncServiceRunning: false, status: "unknown" },
  services: [{ name: "Spooler", expectedState: "running", actualState: "running" }],
  updates: { pendingCount: 2, pendingSecurityCount: 0, failedCount: 0, rebootPending: false },
  recentEvents: [],
  user: { sessionState: "active" },
};

function toHeartbeat(site: { name: string; slug: string; primary_ip: string }, detail: typeof samplePsOutput) {
  const now = new Date().toISOString();
  const printers = detail.printers;
  const anyPrinterFault = printers.some((p) => !p.online);
  return HeartbeatPayload.parse({
    schemaVersion: 1,
    collector: "agent-less",
    collectedAt: now,
    branch: site.name,
    hostname: detail.hostname,
    online: true,
    networkLatencyMs: detail.network.internetLatencyMs,
    ramUsage: detail.ram.usagePercent,
    diskFreePercent: detail.storage.volumes[0].freePercent,
    printer: anyPrinterFault ? "critical" : "healthy",
    email: detail.emailDetail.status,
    endpointSecurity: detail.security.status,
    tightvnc: detail.tightVncDetail.serviceRunning ? "running" : "stopped",
    enquest: detail.enquestDetail.status,
    lastSeen: now,
    machine: { hostname: detail.hostname, branchSlug: site.slug, ip: site.primary_ip, assetType: "workstation", ...detail.machine },
    cpu: detail.cpu,
    ram: detail.ram,
    storage: detail.storage,
    windows: detail.windows,
    network: detail.network,
    tightVncDetail: detail.tightVncDetail,
    security: detail.security,
    printers: detail.printers,
    emailDetail: detail.emailDetail,
    enquestDetail: detail.enquestDetail,
    services: detail.services,
    applications: [],
    updates: detail.updates,
    recentEvents: detail.recentEvents,
    user: detail.user,
  });
}

describe("agent-less PowerShell-output-to-heartbeat transform", () => {
  it("produces a contract-valid heartbeat from realistic collect.ps1 output", () => {
    const hb = toHeartbeat({ name: "Junction Mall", slug: "junction-mall", primary_ip: "192.168.8.15" }, samplePsOutput);
    expect(hb.branch).toBe("Junction Mall");
    expect(hb.collector).toBe("agent-less");
    expect(hb.ramUsage).toBe(63);
  });

  it("flags printer status critical when any printer is offline", () => {
    const faulty = { ...samplePsOutput, printers: [{ ...samplePsOutput.printers[0], online: false }] };
    const hb = toHeartbeat({ name: "Junction Mall", slug: "junction-mall", primary_ip: "192.168.8.15" }, faulty as any);
    expect(hb.printer).toBe("critical");
  });
});
