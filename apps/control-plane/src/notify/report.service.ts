import { db } from "../db.js";
import { getIncidentCauseBreakdown } from "../tickets/recurrence.service.js";

/**
 * The morning report from the plan's Reports section: branch/device
 * counts by health status, the critical list, and cause-analytics
 * percentages ("Enquest sync 31%, printer queues 22%..."). Called by a
 * scheduled job (cron, or a control-plane endpoint a scheduler hits) — see
 * report() below for the shape sent to the console, WhatsApp, and email.
 */

export interface DailyReport {
  generatedAt: string;
  branchCount: number;
  deviceCount: number;
  healthy: number;
  warning: number;
  critical: number;
  offlineOrStale: number;
  criticalItems: { branchName: string; hostname: string; issue: string }[];
  networkSummary: { healthySites: number; totalSites: number };
  securitySummary: { protected: number; issues: number };
  enquestSummary: { healthy: number; warnings: number; unavailable: number };
  causeBreakdown: { category: string; count: number; percent: number }[];
}

export async function generateDailyReport(): Promise<DailyReport> {
  const { data: assets, error: assetsError } = await db
    .from("assets")
    .select("hostname, site_id, sites(name), asset_health(status, printer_status, endpoint_security_status, enquest_status)");
  if (assetsError) throw assetsError;

  const rows = assets ?? [];
  const health = (r: (typeof rows)[number]) => (Array.isArray(r.asset_health) ? r.asset_health[0] : r.asset_health);

  const healthy = rows.filter((r) => health(r)?.status === "healthy").length;
  const warning = rows.filter((r) => health(r)?.status === "warning").length;
  const critical = rows.filter((r) => health(r)?.status === "critical").length;
  const offlineOrStale = rows.filter((r) => ["stale", "unknown"].includes(health(r)?.status ?? "unknown")).length;

  const criticalItems = rows
    .filter((r) => health(r)?.status === "critical")
    .map((r) => {
      const h = health(r);
      const issue = h?.printer_status === "critical"
        ? "Printer offline"
        : h?.endpoint_security_status === "critical"
          ? "Endpoint protection stopped"
          : h?.enquest_status === "critical"
            ? "Enquest sync stopped"
            : "Critical";
      const siteRel = (r as any).sites;
      const branchName = Array.isArray(siteRel) ? siteRel[0]?.name : siteRel?.name;
      return { branchName: branchName ?? "Unknown", hostname: r.hostname, issue };
    });

  const { data: sites } = await db.from("sites").select("id");
  const totalSites = sites?.length ?? 0;
  const criticalSiteIds = new Set(criticalItems.map((_, i) => rows[i]?.site_id).filter(Boolean));
  const healthySites = totalSites - criticalSiteIds.size;

  const protectedCount = rows.filter((r) => health(r)?.endpoint_security_status === "healthy").length;
  const securityIssues = rows.filter((r) => health(r)?.endpoint_security_status === "critical").length;

  const enquestHealthy = rows.filter((r) => health(r)?.enquest_status === "healthy").length;
  const enquestWarnings = rows.filter((r) => health(r)?.enquest_status === "warning").length;
  const enquestUnavailable = rows.filter((r) => health(r)?.enquest_status === "critical").length;

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const causeBreakdown = await getIncidentCauseBreakdown(since);

  return {
    generatedAt: new Date().toISOString(),
    branchCount: totalSites,
    deviceCount: rows.length,
    healthy,
    warning,
    critical,
    offlineOrStale,
    criticalItems,
    networkSummary: { healthySites, totalSites },
    securitySummary: { protected: protectedCount, issues: securityIssues },
    enquestSummary: { healthy: enquestHealthy, warnings: enquestWarnings, unavailable: enquestUnavailable },
    causeBreakdown,
  };
}

/** Renders the report as the fixed-width text block from the plan's Reports section. */
export function formatDailyReportText(report: DailyReport): string {
  const lines = [
    "CITYWALK IT — DAILY HEALTH",
    `Branches ${report.branchCount} · Devices ${report.deviceCount}`,
    `Healthy ${report.healthy} · Warning ${report.warning} · Critical ${report.critical} · Offline ${report.offlineOrStale}`,
    "─────────────────────────────────",
  ];
  if (report.criticalItems.length > 0) {
    lines.push("CRITICAL");
    for (const item of report.criticalItems) {
      lines.push(`${item.branchName} / ${item.hostname}      ${item.issue}`);
    }
  }
  lines.push(
    `NETWORK   ${report.networkSummary.healthySites}/${report.networkSummary.totalSites} healthy`,
    `SECURITY  ${report.securitySummary.protected} protected · ${report.securitySummary.issues} issue${report.securitySummary.issues === 1 ? "" : "s"}`,
    `ENQUEST   ${report.enquestSummary.healthy} healthy · ${report.enquestSummary.warnings} sync warnings · ${report.enquestSummary.unavailable} unavailable`,
  );
  return lines.join("\n");
}
