import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What ingest turns into an alert decides what the console announces out
 * loud, so these are the rules the demo depends on:
 *
 *  - a printer fault raises a p2, because the fleet table going red is
 *    useless if nobody is told; and
 *  - "unknown" never raises anything, because collect.ps1 reports
 *    enquestDetail.status = 'unknown' on every machine that has no Enquest
 *    install. Alerting on that gave every laptop a permanent p3 within
 *    seconds of joining, deduped open forever by raiseAlert's fingerprint
 *    check, which trains an operator to ignore alerts entirely.
 */

const state = vi.hoisted(() => ({
  alerts: [] as any[],
  checks: [] as any[],
  existingOpenFingerprints: [] as string[],
}));

vi.mock("../src/db.js", () => {
  function table(name: string) {
    const chain: any = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        if (name === "alerts" && col === "fingerprint") chain._fp = val;
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      upsert: async () => ({ error: null }),
      update: () => chain,
      insert: async (rows: any) => {
        if (name === "alerts") state.alerts.push(...(Array.isArray(rows) ? rows : [rows]));
        if (name === "checks") state.checks.push(...(Array.isArray(rows) ? rows : [rows]));
        return { error: null };
      },
      maybeSingle: async () => {
        if (name === "sites") return { data: { id: "site-1" }, error: null };
        if (name === "assets") return { data: { id: "asset-1", site_id: "site-1" }, error: null };
        if (name === "alerts") {
          const open = state.existingOpenFingerprints.includes(chain._fp);
          return { data: open ? { id: "existing" } : null, error: null };
        }
        return { data: null, error: null };
      },
      single: async () => ({ data: { id: "asset-1", site_id: "site-1" }, error: null }),
      then: (resolve: any) => resolve({ data: [], error: null }),
    };
    return chain;
  }
  return { db: { from: (name: string) => table(name) } };
});

const { ingestHeartbeat } = await import("../src/ingest/ingest.service.js");

/** A minimal payload that satisfies HeartbeatPayload and is healthy by default. */
function heartbeat(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    collector: "agent-node",
    collectedAt: now,
    branch: "Lagos",
    hostname: "LAGOS-POS-01",
    online: true,
    ramUsage: 40,
    diskFreePercent: 60,
    printer: "healthy",
    email: "unknown",
    endpointSecurity: "healthy",
    tightvnc: "running",
    enquest: "unknown",
    lastSeen: now,
    machine: { hostname: "LAGOS-POS-01", branchSlug: "lagos", ip: "192.168.1.11", assetType: "workstation" },
    cpu: { model: "test", usagePercent: 10 },
    ram: { installedMb: 16384, availableMb: 8192, usagePercent: 40, topConsumers: [] },
    storage: { volumes: [{ drive: "C:", capacityMb: 500000, freeMb: 300000, freePercent: 60 }] },
    windows: { version: "11", build: "22631", activationStatus: "licensed", uptimeSeconds: 18000, rebootPending: false },
    network: { linkState: "wifi", internetReachable: true },
    tightVncDetail: { installed: true, serviceRunning: true, portReachable: true },
    security: { product: "Defender", serviceRunning: true, protectionEnabled: true, firewallProfilesEnabled: [], status: "healthy" },
    printers: [],
    emailDetail: { clientInstalled: false, profileConfigured: false, serverReachable: false, authOk: false, processRunning: false, status: "unknown" },
    enquestDetail: { installed: false, processRunning: false, databaseReachable: false, syncServiceRunning: false, status: "unknown" },
    services: [],
    applications: [],
    updates: { pendingCount: 0, pendingSecurityCount: 0, failedCount: 0, rebootPending: false },
    recentEvents: [],
    user: { loggedInUser: "demo", sessionState: "active" },
    ...overrides,
  };
}

beforeEach(() => {
  state.alerts = [];
  state.checks = [];
  state.existingOpenFingerprints = [];
});

describe("'unknown' is a coverage gap, not a fault", () => {
  it("raises NOTHING for a machine with no Enquest and no readable mail profile", async () => {
    // This is every laptop in the demo fleet on its very first heartbeat.
    await ingestHeartbeat(heartbeat());
    expect(state.alerts).toHaveLength(0);
  });

  it("still raises for a genuine Enquest fault", async () => {
    await ingestHeartbeat(heartbeat({ enquest: "critical" }));
    expect(state.alerts.map((a) => a.fingerprint)).toContain("enquest_sync:asset-1");
    expect(state.alerts[0].severity).toBe("p2");
  });

  it("does not raise p1 for unknown endpoint security, but does for a real one", async () => {
    await ingestHeartbeat(heartbeat({ endpointSecurity: "unknown" }));
    expect(state.alerts).toHaveLength(0);

    await ingestHeartbeat(heartbeat({ endpointSecurity: "critical" }));
    expect(state.alerts.filter((a) => a.severity === "p1")).toHaveLength(1);
  });
});

describe("a printer fault is announced, not just coloured in", () => {
  const offlinePrinter = {
    name: "HP LaserJet 402",
    isDefault: true,
    online: false,
    queueDepth: 3,
    errorState: "offline",
    faultClass: "physical_printer_problem",
  };

  it("raises a p2 so the console's announcer speaks it", async () => {
    await ingestHeartbeat(heartbeat({ printer: "critical", printers: [offlinePrinter] }));
    const alert = state.alerts.find((a) => a.fingerprint.startsWith("printer_chain:"));
    expect(alert, "a printer fault must raise an alert").toBeDefined();
    // AlertAnnouncer only speaks p1/p2 — p3 would be silent on stage.
    expect(alert.severity).toBe("p2");
    expect(alert.title).toContain("HP LaserJet 402");
  });

  it("keys the fingerprint on faultClass so different causes are different incidents", async () => {
    await ingestHeartbeat(heartbeat({ printer: "critical", printers: [offlinePrinter] }));
    expect(state.alerts[0].fingerprint).toBe("printer_chain:asset-1:physical_printer_problem");
  });

  it("does not alert for an online printer, or for one with no classified fault", async () => {
    await ingestHeartbeat(heartbeat({ printers: [{ ...offlinePrinter, online: true }] }));
    await ingestHeartbeat(heartbeat({ printers: [{ ...offlinePrinter, faultClass: "none" }] }));
    expect(state.alerts.filter((a) => a.fingerprint.startsWith("printer_chain:"))).toHaveLength(0);
  });

  it("does not re-raise while the same fault is already open", async () => {
    state.existingOpenFingerprints = ["printer_chain:asset-1:physical_printer_problem"];
    await ingestHeartbeat(heartbeat({ printer: "critical", printers: [offlinePrinter] }));
    expect(state.alerts).toHaveLength(0);
  });

  it("still records a checks row for the fault chain", async () => {
    await ingestHeartbeat(heartbeat({ printer: "critical", printers: [offlinePrinter] }));
    expect(state.checks[0]).toMatchObject({ check_type: "printer_chain", status: "critical" });
  });
});
