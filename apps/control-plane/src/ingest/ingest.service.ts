import { HeartbeatPayload, stripWireNulls } from "@it-sentinel/contracts";
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

/** Raised when a still-running agent reports for a machine that was retired. */
export class AssetRetiredError extends Error {
  constructor(
    public readonly hostname: string,
    public readonly decommissionedAt: string,
  ) {
    super(
      `${hostname} was retired from the roster at ${decommissionedAt}; uninstall the agent on that machine (scripts/uninstall-sentinel-agent.ps1)`,
    );
  }
}

/**
 * Was this asset moved to its current branch by an operator?
 *
 * The audit row is the evidence, not a convenience: reassign_asset() writes
 * one on every real move, and it is the only thing that can change an asset's
 * site_id (there is no update policy on `assets`, by design — see migration
 * 0028). So "has a reassignment row" and "an operator deliberately put this
 * machine where it is" are the same statement, which is precisely the
 * question the hostname lookup needs answered before it adopts a row that
 * sits at a branch the agent did not claim.
 *
 * Only reached when the claimed branch and the roster disagree, which is rare
 * — it costs nothing on the normal heartbeat path.
 */
async function wasReassigned(assetId: string): Promise<boolean> {
  const { data, error } = await db
    .from("audit_log")
    .select("id")
    .eq("target_id", assetId)
    .eq("action", "asset.reassigned")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

function deriveHealthStatus(hb: HeartbeatPayload): "healthy" | "warning" | "critical" {
  const substatuses = [hb.printer, hb.email, hb.endpointSecurity, hb.enquest];
  if (substatuses.includes("critical") || !hb.online) return "critical";
  if (substatuses.includes("warning")) return "warning";
  return "healthy";
}

export async function ingestHeartbeat(raw: unknown) {
  // Applied here too, not only in agent-node: agent-less, agent-dotnet and
  // anything future hit this same JSON-null-vs-undefined mismatch, and the
  // boundary is the one place that sees all of them.
  const parsed = HeartbeatPayload.safeParse(stripWireNulls(raw));
  if (!parsed.success) {
    throw new HeartbeatValidationError(parsed.error.issues);
  }
  const hb = parsed.data;

  // The branch the agent CLAIMS, from SENTINEL_BRANCH_SLUG in its .env. An
  // unknown slug still fails hard below, because that is a real config error
  // rather than a new machine — but from here on it is a claim to be checked
  // against the roster, not the last word on where the machine lives.
  const { data: site, error: siteError } = await db
    .from("sites")
    .select("id")
    .eq("slug", hb.machine.branchSlug)
    .maybeSingle();
  if (siteError) throw siteError;
  if (!site) throw new UnknownAssetError(hb.hostname, hb.machine.branchSlug);

  // Two requirements pull this lookup in opposite directions, and both are
  // real.
  //
  //  (a) It must NOT match on hostname alone. `assets` declares
  //      `unique (site_id, hostname)` — hostnames are unique per site, not
  //      per fleet — and matching fleet-wide once meant two machines sharing
  //      a hostname (routine with cloned Windows images) collapsed onto a
  //      single row: the second machine's heartbeats overwrote the first's
  //      health and one branch rendered empty with no error anywhere.
  //
  //  (b) It must NOT be scoped to the claimed site either. reassign_asset()
  //      (migration 0028) lets an operator move a machine to another branch,
  //      and the agent on that machine keeps sending the OLD slug until
  //      somebody edits its .env. A site-scoped lookup finds nothing, falls
  //      through to auto-provision, and quietly creates a SECOND asset — so
  //      the operator's correction produces exactly the duplicate they were
  //      trying to avoid, and the machine appears at two branches at once.
  //
  // Both are satisfied by asking a narrower question than "which asset has
  // this hostname": match within the claimed site FIRST, which is the common
  // case and keeps (a) exactly as it was, and only look further when there is
  // no match there. A row found at a different site is adopted only if an
  // operator actually moved it — proven by its own reassignment audit row,
  // which is the only way site_id can change (no update policy on assets
  // exists). That distinction is what keeps (a) intact: a genuinely new
  // machine that happens to share a hostname with one at another branch has
  // no such row, so it is provisioned here as its own asset, as before.
  const { data: sameHostname, error: assetLookupError } = await db
    .from("assets")
    .select("id, site_id, decommissioned_at")
    .eq("hostname", hb.hostname);
  if (assetLookupError) throw assetLookupError;

  const candidates = (sameHostname ?? []) as {
    id: string;
    site_id: string;
    decommissioned_at: string | null;
  }[];
  let existingAsset = candidates.find((a) => a.site_id === site.id) ?? null;

  if (!existingAsset) {
    // Only one, deliberately. If several branches hold this hostname the
    // fleet cannot tell which of them the heartbeat belongs to, and guessing
    // would rewrite a machine that is reporting perfectly well elsewhere —
    // so that case falls through to provisioning at the claimed site, which
    // is the honest answer and the one the unique constraint allows.
    const moved = candidates.length === 1 ? candidates[0]! : null;
    if (moved && (await wasReassigned(moved.id))) {
      // The roster wins over the .env, and says so out loud. This is not
      // noise: it is the one signal that a machine's SENTINEL_BRANCH_SLUG is
      // stale, and nothing else in the system can see it — the agent has no
      // idea it was moved and the operator who moved it never touched the
      // machine.
      console.warn(
        `[ingest] ${hb.hostname} claims branch '${hb.machine.branchSlug}' but the roster has it at site ${moved.site_id} (reassigned by an operator). Keeping the roster's branch; update SENTINEL_BRANCH_SLUG on that machine.`,
      );
      existingAsset = moved;
    }
  }

  // site_id comes from the ASSET, never from the claimed slug, so everything
  // downstream — alerts, checks, the branch a fault renders under — follows
  // the reassignment rather than the stale .env.
  let asset: { id: string; site_id: string } | null = existingAsset
    ? { id: existingAsset.id, site_id: existingAsset.site_id }
    : null;

  // A retired machine is out of the fleet, and its heartbeats stop counting
  // the moment it is. Accepting them looks harmless — the row stays retired
  // and hidden — but it keeps rewriting asset_health and appending telemetry,
  // so a later restore_asset() brings the machine back reporting green as
  // though it had never left. That is a lie about a machine nobody has been
  // watching.
  //
  // Refused with 410 Gone rather than 404: the asset genuinely exists and the
  // agent is correctly configured, it has simply been taken off the roster.
  // An agent that gets this should be uninstalled — see
  // scripts/uninstall-sentinel-agent.ps1 — and saying so plainly beats a 404
  // that reads as "your branch slug is wrong".
  if (existingAsset?.decommissioned_at) {
    throw new AssetRetiredError(hb.hostname, existingAsset.decommissioned_at);
  }

  if (!asset) {
    // First heartbeat from a machine we haven't seen — auto-provision it
    // under its branch rather than requiring hundreds of assets to be
    // hand-seeded before agent-less can give day-one coverage. The branch
    // was already resolved above; an unknown *branch* fails hard there,
    // since that indicates a real config error rather than a new machine.
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

  // A printer fault is the most common real-world incident at a branch and
  // the one an operator most needs told about, but it used to write a
  // `checks` row and nothing else — no alert, so nothing surfaced it and the
  // console's announcer (which speaks p1/p2) stayed silent while the fleet
  // table went red. A red row nobody is told about is a dashboard you have
  // to be already staring at.
  const faultedPrinters = hb.printers.filter((p) => !p.online && p.faultClass !== "none");
  if (faultedPrinters.length > 0) {
    // faultClass is part of the fingerprint so a driver fault and a network
    // fault on the same machine are separate incidents — they have different
    // fixes, and recurrence intelligence keys off this.
    const worst = faultedPrinters[0]!;
    await raiseAlert({
      assetId,
      siteId,
      fingerprint: `printer_chain:${assetId}:${worst.faultClass}`,
      severity: "p2",
      title: `Printer ${worst.name} offline on ${hb.hostname}`,
      detail: { name: worst.name, faultClass: worst.faultClass, queueDepth: worst.queueDepth, errorState: worst.errorState },
    });
  }

  // "unknown" is deliberately NOT an alert, for either of the checks below.
  //
  // It means the collector could not determine the state — Enquest is not
  // installed on this machine, the mail profile could not be read — which is
  // a coverage gap, not a fault. Alerting on it meant every laptop raised a
  // permanent p3 the moment it first reported (collect.ps1 hardcodes
  // enquestDetail.status = 'unknown'), raiseAlert deduped it open forever,
  // and the operator learned within a day that alerts mean nothing. An alert
  // that is always firing is worse than no alert.
  if (hb.enquest === "warning" || hb.enquest === "critical") {
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

  if (hb.endpointSecurity === "warning" || hb.endpointSecurity === "critical") {
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
