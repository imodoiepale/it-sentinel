import { HealthStatus } from "@it-sentinel/contracts";

export interface FleetRow {
  assetId: string;
  hostname: string;
  branchName: string;
  branchSlug: string;
  online: boolean;
  status: HealthStatus;
  networkLatencyMs: number | null;
  ramUsage: number | null;
  diskFreePercent: number | null;
  printerStatus: HealthStatus;
  emailStatus: HealthStatus;
  endpointSecurityStatus: HealthStatus;
  tightvncStatus: string;
  enquestStatus: HealthStatus;
  lastHeartbeatAt: string | null;
  openTicketCount: number;
}

export interface BranchNode {
  siteId: string;
  name: string;
  slug: string;
  region: string;
  criticality: string;
  overallStatus: HealthStatus;
  assets: FleetRow[];
}
