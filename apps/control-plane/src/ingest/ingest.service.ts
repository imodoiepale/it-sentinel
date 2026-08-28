import { HeartbeatPayload } from "@it-sentinel/contracts";
import { db } from "../db.js";

/**
 * The one entry point for every collector (agent-node, agent-dotnet,
 * agent-less). Validates against the shared contract *before* touching the
 * database — an agent sending malformed data is refused, not silently
 * accepted, and telemetry never contains a shape the console doesn't expect.
 */

export class HeartbeatValidationError extends Error {
  constructor(public readonly issues: unknown) {
    super("heartbeat failed contract validation");
  }
}

export class UnknownAssetError extends Error {
  constructor(hostname: string, branchSlug: string) {
    super(`no asset registered for hostname=${hostname} branch=${branchSlug}`);
  }
}

function deriveHealthStatus(hb: HeartbeatPayload): "healthy" | "warning" | "critical" {
  const substatuses = [hb.printer, hb.email, hb.endpointSecurity, hb.enquest];
  if (substatuses.includes("critical") || !hb.online) return "critical";
  if (substatuses.includes("warning")) return "warning";
  return "healthy";
}

export async function ingestHeartbeat(raw: unknown) {
  const parsed = HeartbeatPayload.safeParse(raw);
  if (!parsed.success) {
    throw new HeartbeatValidationError(parsed.error.issues);
  }
  const hb = parsed.data;

  let asset: { id: string; site_id: string } | null;
  const { data: existingAsset, error: assetLookupError } = await db
    .from("assets")
    .select("id, site_id")
    .eq("hostname", hb.hostname)
    .maybeSingle();
  if (assetLookupError) throw assetLookupError;
  asset = existingAsset;

  if (!asset) {
    // First heartbeat from a machine we haven't seen — auto-provision it
    // under its branch rather than requiring hundreds of assets to be
    // hand-seeded before agent-less can give day-one coverage. The branch
    // itself must already exist (seeded from the spreadsheet); an unknown
    // *branch* still fails hard, since that indicates a real config error.
    const { data: site, error: siteError } = await db
      .from("sites")
      .select("id")
      .eq("slug", hb.machine.branchSlug)
      .maybeSingle();
    if (siteError) throw siteError;
    if (!site) throw new UnknownAssetError(hb.hostname, hb.machine.branchSlug);

    const { data: created, error: createError } = await db
      .from("assets")
      .insert({
        site_id: site.id,
        hostname: hb.hostname,
        ip: hb.machine.ip,
        asset_type: hb.machine.assetType,
        serial: hb.machine.serial ?? null,
        model: hb.machine.model ?? null,
        manufacturer: hb.machine.manufacturer ?? null,
        agent_collector: hb.collector,
      })
      .select("id, site_id")
      .single();
    if (createError) throw createError;
    asset = created;

    await db.from("audit_log").insert({
      actor_kind: "system",
      action: "asset.auto_provisioned",
      target_type: "asset",
      target_id: asset.id,
      decision: "allowed",
      detail: { hostname: hb.hostname, branch_slug: hb.machine.branchSlug, collector: hb.collector },
    });
  }

  const status = deriveHealthStatus(hb);

  const { error: healthError } = await db.from("asset_health").upsert(
    {
      asset_id: asset.id,
      online: hb.online,
      status,
      network_latency_ms: hb.networkLatencyMs ?? null,
      ram_usage: hb.ramUsage,
      disk_free_percent: hb.diskFreePercent,
      printer_status: hb.printer,
      email_status: hb.email,
      endpoint_security_status: hb.endpointSecurity,
      tightvnc_status: hb.tightvnc,
      enquest_status: hb.enquest,
      last_heartbeat_at: hb.lastSeen,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "asset_id" },
  );
  if (healthError) throw healthError;

  const { error: telemetryError } = await db.from("telemetry").insert({
    asset_id: asset.id,
    recorded_at: hb.collectedAt,
    payload: hb,
  });
  if (telemetryError) throw telemetryError;

  await db
    .from("assets")
    .update({ last_seen_at: hb.lastSeen, ip: hb.machine.ip })
    .eq("id", asset.id);

  await evaluateChecks(asset.id, asset.site_id, hb);

  return { assetId: asset.id, status };
}

/**
 * Per-heartbeat check evaluation: the printer fault chain (which check
 * classifies pc/network/physical/driver, per the plan's diagnostic modules)
 * and a raw alert for any red status, deduplicated by fingerprint so a
 * flapping fault doesn't spam a new incident every 60 seconds.
 */
async function evaluateChecks(assetId: string, siteId: string, hb: HeartbeatPayload) {
  const rows = hb.printers.map((p) => ({
    asset_id: assetId,
    site_id: siteId,
    check_type: "printer_chain",
    status: p.online ? "healthy" : p.faultClass === "none" ? "warning" : "critical",
    fault_class: p.faultClass,
    detail: { name: p.name, queueDepth: p.queueDepth, errorState: p.errorState },
  }));
  if (rows.length > 0) {
    const { error } = await db.from("checks").insert(rows);
    if (error) throw error;
  }

  if (hb.enquest !== "healthy") {
    const fingerprint = `enquest_sync:${assetId}`;
    await raiseAlert({
      assetId,
      siteId,
      fingerprint,
      severity: hb.enquest === "critical" ? "p2" : "p3",
      title: `Enquest ${hb.enquest} on ${hb.hostname}`,
      detail: { mostCommonError: hb.enquestDetail.mostCommonError, recentErrorCount: hb.enquestDetail.recentErrorCount },
    });
  }

  if (hb.endpointSecurity !== "healthy") {
    const fingerprint = `endpoint_security:${assetId}`;
    await raiseAlert({
      assetId,
      siteId,
      fingerprint,
      severity: "p1",
      title: `Endpoint protection ${hb.endpointSecurity} on ${hb.hostname}`,
      detail: { product: hb.security.product, tamperProtectionEnabled: hb.security.tamperProtectionEnabled },
    });
  }
}

async function raiseAlert(args: {
  assetId: string;
  siteId: string;
  fingerprint: string;
  severity: "p1" | "p2" | "p3" | "p4";
  title: string;
  detail: Record<string, unknown>;
}) {
  const { data: existing } = await db
    .from("alerts")
    .select("id")
    .eq("fingerprint", args.fingerprint)
    .eq("status", "open")
    .maybeSingle();

  if (existing) return; // already open — don't duplicate

  const { error } = await db.from("alerts").insert({
    asset_id: args.assetId,
    site_id: args.siteId,
    fingerprint: args.fingerprint,
    severity: args.severity,
    title: args.title,
    detail: args.detail,
  });
  if (error) throw error;
}
