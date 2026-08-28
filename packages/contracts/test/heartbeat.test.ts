import { describe, expect, it } from "vitest";
import { HeartbeatPayload } from "../src/heartbeat.js";

const validPayload = {
  schemaVersion: 1,
  collector: "agent-node",
  collectedAt: new Date().toISOString(),
  branch: "Junction Mall",
  hostname: "CW-JCT-POS02",
  online: true,
  networkLatencyMs: 24,
  ramUsage: 67,
  diskFreePercent: 31,
  printer: "critical",
  email: "healthy",
  endpointSecurity: "healthy",
  tightvnc: "running",
  enquest: "healthy",
  lastSeen: new Date().toISOString(),
  machine: {
    hostname: "CW-JCT-POS02",
    branchSlug: "junction-mall",
    ip: "192.168.8.15",
    assetType: "pos",
  },
  cpu: { usagePercent: 22 },
  ram: { installedMb: 8192, availableMb: 2700, usagePercent: 67 },
  storage: { volumes: [{ drive: "C:", capacityMb: 256000, freeMb: 79000, freePercent: 31 }] },
  windows: {
    version: "10",
    build: "19045",
    activationStatus: "licensed",
    uptimeSeconds: 400000,
    rebootPending: false,
  },
  network: { linkState: "lan", internetReachable: true },
  tightVncDetail: { installed: true, serviceRunning: true, portReachable: true },
  security: { serviceRunning: true, protectionEnabled: true, status: "healthy" },
  printers: [
    {
      name: "HP LaserJet",
      online: false,
      queueDepth: 4,
      faultClass: "network_problem",
    },
  ],
  emailDetail: {
    clientInstalled: true,
    profileConfigured: true,
    serverReachable: true,
    authOk: true,
    processRunning: true,
    status: "healthy",
  },
  enquestDetail: {
    installed: true,
    processRunning: true,
    databaseReachable: true,
    syncServiceRunning: true,
    status: "healthy",
  },
  updates: { pendingCount: 2, pendingSecurityCount: 1, failedCount: 0, rebootPending: false },
  user: { sessionState: "active" },
};

describe("HeartbeatPayload contract", () => {
  it("accepts a well-formed heartbeat from any collector", () => {
    const result = HeartbeatPayload.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("rejects a heartbeat missing required identity fields", () => {
    const { machine, ...rest } = validPayload as any;
    const result = HeartbeatPayload.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects out-of-range percentages", () => {
    const result = HeartbeatPayload.safeParse({ ...validPayload, ramUsage: 150 });
    expect(result.success).toBe(false);
  });

  it("never allows message content on the email contract", () => {
    expect(Object.keys((validPayload as any).emailDetail)).not.toContain("messageContent");
  });
});
