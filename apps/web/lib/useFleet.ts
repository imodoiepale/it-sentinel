"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { subscribeToFleetUpdates, unsubscribe } from "./realtime";
import type { BranchNode, FleetRow } from "./types";

/**
 * Loads the operator's scoped branch/asset tree and keeps it live via the
 * single realtime channel. RLS does the actual access control — this hook
 * simply renders whatever `sites`/`assets`/`asset_health` RLS lets the
 * current session see, so a change here can never widen access, only
 * reflect it.
 */
export function useFleet() {
  const [branches, setBranches] = useState<BranchNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const { data: sites, error: sitesError } = await supabase
      .from("sites")
      .select("id, name, slug, region, criticality")
      .order("name");
    if (sitesError) {
      setError(sitesError.message);
      setLoading(false);
      return;
    }

    const { data: assets, error: assetsError } = await supabase
      .from("assets")
      .select(
        "id, hostname, site_id, asset_health(online, status, network_latency_ms, ram_usage, disk_free_percent, printer_status, email_status, endpoint_security_status, tightvnc_status, enquest_status, last_heartbeat_at)",
      );
    if (assetsError) {
      setError(assetsError.message);
      setLoading(false);
      return;
    }

    const bySite = new Map<string, FleetRow[]>();
    for (const a of assets ?? []) {
      const health = Array.isArray(a.asset_health) ? a.asset_health[0] : a.asset_health;
      const row: FleetRow = {
        assetId: a.id,
        hostname: a.hostname,
        branchName: "",
        branchSlug: "",
        online: health?.online ?? false,
        status: (health?.status as any) ?? "unknown",
        networkLatencyMs: health?.network_latency_ms ?? null,
        ramUsage: health?.ram_usage ?? null,
        diskFreePercent: health?.disk_free_percent ?? null,
        printerStatus: (health?.printer_status as any) ?? "unknown",
        emailStatus: (health?.email_status as any) ?? "unknown",
        endpointSecurityStatus: (health?.endpoint_security_status as any) ?? "unknown",
        tightvncStatus: health?.tightvnc_status ?? "unknown",
        enquestStatus: (health?.enquest_status as any) ?? "unknown",
        lastHeartbeatAt: health?.last_heartbeat_at ?? null,
        openTicketCount: 0,
      };
      const list = bySite.get(a.site_id) ?? [];
      list.push(row);
      bySite.set(a.site_id, list);
    }

    const tree: BranchNode[] = (sites ?? []).map((s) => {
      const siteAssets = (bySite.get(s.id) ?? []).map((row) => ({ ...row, branchName: s.name, branchSlug: s.slug }));
      const worst = siteAssets.some((r) => r.status === "critical")
        ? "critical"
        : siteAssets.some((r) => r.status === "warning")
          ? "warning"
          : siteAssets.some((r) => r.status === "stale")
            ? "stale"
            : siteAssets.length === 0
              ? "unknown"
              : "healthy";
      return {
        siteId: s.id,
        name: s.name,
        slug: s.slug,
        region: s.region,
        criticality: s.criticality,
        overallStatus: worst as any,
        assets: siteAssets,
      };
    });

    setBranches(tree);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
    const channel = subscribeToFleetUpdates({
      onAssetHealthChange: () => reload(),
      onAlertChange: () => reload(),
      onIncidentChange: () => reload(),
    });
    return () => unsubscribe(channel);
  }, [reload]);

  return { branches, loading, error, reload };
}
