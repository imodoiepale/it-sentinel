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
  assetDecommissionedAt: null as string | null,
  /** The site the agent's branchSlug resolves to — what its .env claims. */
  claimedSiteId: "site-1" as string | null,
  /** Every asset in the fleet sharing this hostname, at whatever site. */
  assetRows: [] as any[],
  /** Assets with an `asset.reassigned` audit row, i.e. moved by an operator. */
  reassignedAssetIds: [] as string[],
  insertedAssets: [] as any[],
  auditRows: [] as any[],
}));

vi.mock("../src/db.js", () => {
  function table(name: string) {
    const chain: any = {
      // Filters are recorded rather than applied: the lookups under test are
      // distinguished by WHICH column they filter on (audit_log by target_id
      // and action, alerts by fingerprint), so the mock has to see them.
      _filters: {} as Record<string, unknown>,
      select: () => chain,
      eq: (col: string, val: unknown) => {
        chain._filters[col] = val;
        return chain;
      },
      is: () => chain,
      order: () => chain,
      limit: () => chain,
      upsert: async () => ({ error: null }),
      update: () => chain,
      // Returns the chain, not a promise: ingest awaits some inserts directly
      // and follows others with .select().single() to read the new row back.
      insert: (rows: any) => {
        const list = Array.isArray(rows) ? rows : [rows];
        if (name === "alerts") state.alerts.push(...list);
        if (name === "checks") state.checks.push(...list);
        if (name === "assets") state.insertedAssets.push(...list);
        if (name === "audit_log") state.auditRows.push(...list);
        return chain;
      },
      maybeSingle: async () => {
        if (name === "sites") return { data: state.claimedSiteId ? { id: state.claimedSiteId } : null, error: null };
        if (name === "alerts") {
          const open = state.existingOpenFingerprints.includes(chain._filters.fingerprint as string);
          return { data: open ? { id: "existing" } : null, error: null };
        }
        if (name === "audit_log") {
          const moved =
            chain._filters.action === "asset.reassigned" &&
            state.reassignedAssetIds.includes(chain._filters.target_id as string);
          return { data: moved ? { id: "audit-1" } : null, error: null };
        }
        return { data: null, error: null };
      },
      single: async () => {
        const created = state.insertedAssets[state.insertedAssets.length - 1];
        return { data: { id: "asset-new", site_id: created?.site_id }, error: null };
      },
      then: (resolve: any) => resolve({ data: name === "assets" ? state.assetRows : [], error: null }),
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
  state.assetDecommissionedAt = null;
  state.claimedSiteId = "site-1";
  // The ordinary case: the machine is on the roster at the branch its .env
  // claims, which is what every test here assumes unless it says otherwise.
  state.assetRows = [{ id: "asset-1", site_id: "site-1", decommissioned_at: null }];
  state.reassignedAssetIds = [];
  state.insertedAssets = [];
  state.auditRows = [];
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

describe("a retired machine's heartbeats are refused", () => {
  function retire() {
    state.assetDecommissionedAt = new Date().toISOString();
    state.assetRows = [{ id: "asset-1", site_id: "site-1", decommissioned_at: state.assetDecommissionedAt }];
  }

  it("rejects the heartbeat instead of quietly rewriting its health", async () => {
    // The agent may still be running on a laptop that was taken off the
    // roster. Accepting looks harmless — the row stays hidden — but it keeps
    // asset_health and telemetry current, so a later restore_asset() brings
    // the machine back reporting green as though it had never left.
    retire();
    const { AssetRetiredError } = await import("../src/ingest/ingest.service.js");
    await expect(ingestHeartbeat(heartbeat())).rejects.toBeInstanceOf(AssetRetiredError);
    expect(state.alerts).toHaveLength(0);
    expect(state.checks).toHaveLength(0);
  });

  it("tells the operator what to do about it", async () => {
    retire();
    await expect(ingestHeartbeat(heartbeat())).rejects.toThrow(/uninstall-sentinel-agent/);
  });

  it("still accepts an active machine", async () => {
    state.assetDecommissionedAt = null;
    await expect(ingestHeartbeat(heartbeat())).resolves.toMatchObject({ assetId: "asset-1" });
  });

  it("still refuses after the machine was moved to another branch", async () => {
    // Retirement has to survive a reassignment: the adopted row is the same
    // machine, and it is still off the roster.
    retire();
    state.assetRows = [{ id: "asset-1", site_id: "site-9", decommissioned_at: state.assetDecommissionedAt }];
    state.reassignedAssetIds = ["asset-1"];
    await expect(ingestHeartbeat(heartbeat())).rejects.toThrow(/uninstall-sentinel-agent/);
    expect(state.insertedAssets).toHaveLength(0);
  });
});

/**
 * The reassignment case, which is the whole reason this lookup is no longer
 * scoped to the branch the agent claims.
 *
 * An operator moves a machine with reassign_asset() (migration 0028). Nothing
 * touches the machine itself, so its agent keeps sending the OLD slug — every
 * 60 seconds, indefinitely. What ingest does with that decides whether the
 * operator's correction holds or is quietly undone.
 */
describe("an operator's reassignment survives the agent's stale branch slug", () => {
  const movedAway = () => {
    state.assetRows = [{ id: "asset-1", site_id: "site-9", decommissioned_at: null }];
    state.reassignedAssetIds = ["asset-1"];
  };

  it("keeps the existing asset instead of provisioning a second one at the claimed branch", async () => {
    movedAway();
    const res = await ingestHeartbeat(heartbeat());
    expect(res.assetId).toBe("asset-1");
    // The duplicate is the bug: one physical machine appearing at two
    // branches, with the operator having no way to tell which row is which.
    expect(state.insertedAssets).toHaveLength(0);
  });

  it("files the machine's telemetry under the branch the roster says, not the one its .env claims", async () => {
    movedAway();
    await ingestHeartbeat(
      heartbeat({
        printer: "critical",
        printers: [{ name: "HP LaserJet 402", isDefault: true, online: false, queueDepth: 1, errorState: "offline", faultClass: "driver_problem" }],
      }),
    );
    expect(state.checks[0].site_id).toBe("site-9");
    expect(state.alerts[0].site_id).toBe("site-9");
  });

  it("warns, because a stale SENTINEL_BRANCH_SLUG is invisible everywhere else", async () => {
    movedAway();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ingestHeartbeat(heartbeat());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/SENTINEL_BRANCH_SLUG/);
    warn.mockRestore();
  });

  it("says nothing when the roster and the agent agree", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ingestHeartbeat(heartbeat());
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * The regression this lookup nearly reintroduced. Two machines can genuinely
 * share a hostname at different branches — cloned Windows images make it
 * routine — and `assets` allows it: the unique constraint is on
 * (site_id, hostname), not hostname. Matching fleet-wide once collapsed them
 * onto one row, so the second machine's heartbeats overwrote the first's
 * health and a whole branch rendered empty with no error anywhere.
 */
describe("two machines sharing a hostname at different branches stay two machines", () => {
  it("provisions its own asset for a same-named machine that was never moved", async () => {
    state.assetRows = [{ id: "asset-1", site_id: "site-9", decommissioned_at: null }];
    state.reassignedAssetIds = []; // nobody moved anything — this is a new machine
    const res = await ingestHeartbeat(heartbeat());
    expect(res.assetId).toBe("asset-new");
    expect(state.insertedAssets[0]).toMatchObject({ site_id: "site-1", hostname: "LAGOS-POS-01" });
  });

  it("refuses to guess when several branches already hold the hostname", async () => {
    // Even with a reassignment somewhere in the history, there is no way to
    // tell which of these rows is doing the talking — so it provisions here
    // rather than rewriting a machine that is reporting fine elsewhere.
    state.assetRows = [
      { id: "asset-1", site_id: "site-9", decommissioned_at: null },
      { id: "asset-2", site_id: "site-8", decommissioned_at: null },
    ];
    state.reassignedAssetIds = ["asset-1"];
    const res = await ingestHeartbeat(heartbeat());
    expect(res.assetId).toBe("asset-new");
    expect(state.insertedAssets[0]).toMatchObject({ site_id: "site-1" });
  });

  it("still prefers the row at the claimed branch when one exists there", async () => {
    state.assetRows = [
      { id: "asset-other", site_id: "site-9", decommissioned_at: null },
      { id: "asset-1", site_id: "site-1", decommissioned_at: null },
    ];
    const res = await ingestHeartbeat(heartbeat());
    expect(res.assetId).toBe("asset-1");
    expect(state.insertedAssets).toHaveLength(0);
  });
});
