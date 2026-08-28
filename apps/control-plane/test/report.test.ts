import { describe, expect, it } from "vitest";
import { formatDailyReportText, type DailyReport } from "../src/notify/report.service.js";

const sample: DailyReport = {
  generatedAt: new Date().toISOString(),
  branchCount: 44,
  deviceCount: 1,
  healthy: 0,
  warning: 0,
  critical: 1,
  offlineOrStale: 0,
  criticalItems: [{ branchName: "Junction Mall", hostname: "CW-JCT-POS02", issue: "Printer offline" }],
  networkSummary: { healthySites: 43, totalSites: 44 },
  securitySummary: { protected: 0, issues: 1 },
  enquestSummary: { healthy: 0, warnings: 0, unavailable: 1 },
  causeBreakdown: [{ category: "printer_queues", count: 1, percent: 100 }],
};

describe("formatDailyReportText", () => {
  it("matches the plan's fixed-width report shape", () => {
    const text = formatDailyReportText(sample);
    expect(text).toContain("CITYWALK IT — DAILY HEALTH");
    expect(text).toContain("Branches 44 · Devices 1");
    expect(text).toContain("CRITICAL");
    expect(text).toContain("Junction Mall / CW-JCT-POS02      Printer offline");
    expect(text).toContain("NETWORK   43/44 healthy");
  });

  it("omits the CRITICAL section entirely when nothing is critical", () => {
    const clean: DailyReport = { ...sample, critical: 0, criticalItems: [] };
    const text = formatDailyReportText(clean);
    expect(text).not.toContain("CRITICAL");
  });
});
