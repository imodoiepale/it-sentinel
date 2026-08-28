import { z } from "zod";
import { AssetType, CollectorKind, HealthStatus, PrinterFaultClass } from "./enums.js";

/**
 * The single wire contract every collector (agent-node, agent-dotnet, agent-less)
 * must emit identically. The control plane validates every inbound heartbeat
 * against this schema before it touches the database — a breaking change to
 * this file is a breaking change to the whole fleet, and CI treats it that way.
 */

const MachineIdentity = z.object({
  hostname: z.string().min(1),
  branchSlug: z.string().min(1),
  ip: z.string().ip(),
  mac: z.string().optional(),
  serial: z.string().optional(),
  model: z.string().optional(),
  manufacturer: z.string().optional(),
  assetType: AssetType.default("workstation"),
});

const CpuInfo = z.object({
  model: z.string().optional(),
  usagePercent: z.number().min(0).max(100),
  coreCount: z.number().int().positive().optional(),
  temperatureCelsius: z.number().optional(),
});

const RamInfo = z.object({
  installedMb: z.number().int().nonnegative(),
  availableMb: z.number().int().nonnegative(),
  usagePercent: z.number().min(0).max(100),
  topConsumers: z.array(z.object({ process: z.string(), mb: z.number() })).max(10).optional(),
});

const VolumeInfo = z.object({
  drive: z.string(),
  capacityMb: z.number().int().nonnegative(),
  freeMb: z.number().int().nonnegative(),
  freePercent: z.number().min(0).max(100),
  smartHealthy: z.boolean().optional(),
});

const StorageInfo = z.object({
  volumes: z.array(VolumeInfo).min(1),
});

const WindowsInfo = z.object({
  version: z.string(),
  build: z.string(),
  activationStatus: z.enum(["licensed", "unlicensed", "grace", "unknown"]),
  uptimeSeconds: z.number().int().nonnegative(),
  rebootPending: z.boolean(),
});

const NetworkInfo = z.object({
  linkState: z.enum(["lan", "wifi", "disconnected"]),
  gatewayIp: z.string().ip().optional(),
  dnsServers: z.array(z.string()).default([]),
  latencyMs: z.number().nonnegative().optional(),
  packetLossPercent: z.number().min(0).max(100).optional(),
  linkSpeedMbps: z.number().nonnegative().optional(),
  internetReachable: z.boolean(),
  internetLatencyMs: z.number().nonnegative().optional(),
  publicIp: z.string().optional(),
});

const TightVncInfo = z.object({
  installed: z.boolean(),
  serviceRunning: z.boolean(),
  portReachable: z.boolean(),
  version: z.string().optional(),
});

const SecurityInfo = z.object({
  product: z.string().optional(),
  serviceRunning: z.boolean(),
  protectionEnabled: z.boolean(),
  definitionsAgeHours: z.number().nonnegative().optional(),
  lastScanAt: z.string().datetime().optional(),
  tamperProtectionEnabled: z.boolean().optional(),
  firewallProfilesEnabled: z.array(z.string()).default([]),
  status: HealthStatus,
});

const PrinterInfo = z.object({
  name: z.string(),
  driver: z.string().optional(),
  port: z.string().optional(),
  isDefault: z.boolean().default(false),
  online: z.boolean(),
  queueDepth: z.number().int().nonnegative().default(0),
  errorState: z.string().optional(),
  faultClass: PrinterFaultClass.default("none"),
});

const EmailInfo = z.object({
  clientInstalled: z.boolean(),
  profileConfigured: z.boolean(),
  serverReachable: z.boolean(),
  authOk: z.boolean(),
  processRunning: z.boolean(),
  lastSyncAt: z.string().datetime().optional(),
  sendReceiveErrors: z.number().int().nonnegative().default(0),
  status: HealthStatus,
  // Deliberately no message-content field exists in this contract.
});

const EnquestInfo = z.object({
  installed: z.boolean(),
  processRunning: z.boolean(),
  version: z.string().optional(),
  databaseReachable: z.boolean(),
  syncServiceRunning: z.boolean(),
  lastSuccessfulSyncAt: z.string().datetime().optional(),
  pendingRequisitions: z.number().int().nonnegative().optional(),
  pendingDeliveries: z.number().int().nonnegative().optional(),
  recentErrorCount: z.number().int().nonnegative().default(0),
  mostCommonError: z.string().optional(),
  status: HealthStatus,
});

const ServiceState = z.object({
  name: z.string(),
  expectedState: z.enum(["running", "stopped", "any"]),
  actualState: z.enum(["running", "stopped", "unknown"]),
});

const UpdateInfo = z.object({
  pendingCount: z.number().int().nonnegative(),
  pendingSecurityCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  rebootPending: z.boolean(),
});

const EventLogEntry = z.object({
  source: z.string(),
  level: z.enum(["critical", "error", "warning"]),
  eventId: z.number().int().optional(),
  message: z.string(),
  occurredAt: z.string().datetime(),
  count: z.number().int().positive().default(1),
});

const UserSessionInfo = z.object({
  loggedInUser: z.string().optional(),
  sessionState: z.enum(["active", "locked", "disconnected", "none"]),
  idleSeconds: z.number().int().nonnegative().optional(),
});

const PowerInfo = z.object({
  onUps: z.boolean().optional(),
  batteryPercent: z.number().min(0).max(100).optional(),
  runtimeRemainingMinutes: z.number().nonnegative().optional(),
});

export const HeartbeatPayload = z.object({
  schemaVersion: z.literal(1),
  collector: CollectorKind,
  collectedAt: z.string().datetime(),

  // Summary fields — the compact shape used for the fleet table and quick alerts.
  branch: z.string(),
  hostname: z.string(),
  online: z.boolean(),
  networkLatencyMs: z.number().nonnegative().optional(),
  ramUsage: z.number().min(0).max(100),
  diskFreePercent: z.number().min(0).max(100),
  printer: HealthStatus,
  email: HealthStatus,
  endpointSecurity: HealthStatus,
  tightvnc: z.enum(["running", "stopped", "not_installed", "unreachable"]),
  enquest: HealthStatus,
  lastSeen: z.string().datetime(),

  // Full detail — persisted to `telemetry`, joined for the machine workspace.
  machine: MachineIdentity,
  cpu: CpuInfo,
  ram: RamInfo,
  storage: StorageInfo,
  windows: WindowsInfo,
  network: NetworkInfo,
  tightVncDetail: TightVncInfo,
  security: SecurityInfo,
  printers: z.array(PrinterInfo).default([]),
  emailDetail: EmailInfo,
  enquestDetail: EnquestInfo,
  services: z.array(ServiceState).default([]),
  applications: z.array(z.object({ name: z.string(), version: z.string().optional() })).default([]),
  updates: UpdateInfo,
  recentEvents: z.array(EventLogEntry).max(50).default([]),
  user: UserSessionInfo,
  power: PowerInfo.optional(),
});

export type HeartbeatPayload = z.infer<typeof HeartbeatPayload>;
