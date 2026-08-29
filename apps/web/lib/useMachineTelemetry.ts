"use client";

import { useCallback, useEffect, useState } from "react";
import type { HeartbeatPayload } from "@it-sentinel/contracts";
import { supabase } from "./supabase";

/**
 * The machine workspace's read side. Everything the panel renders about a
 * machine comes from one `telemetry` row plus its `checks` history — the
 * agent already writes the whole heartbeat into `telemetry.payload` on every
 * beat, so this is a rendering problem, not a collection one.
 */

/**
 * Mirrors STALE_TELEMETRY_MS in apps/control-plane/src/voice/voice.routes.ts.
 * Deliberately re-declared rather than imported: that constant lives in a
 * Fastify route the browser bundle cannot reach. Keeping the same number is
 * what stops the console and the voice agent from disagreeing about whether
 * a reading is live — an operator told "that's an hour old" by voice and
 * shown a confident number on screen has been lied to by one of them.
 */
export const STALE_TELEMETRY_MS = 5 * 60 * 1000;

/**
 * A heartbeat that has already been through the wire contract once, read
 * back as Partial. Ingest validated it against HeartbeatPayload, but a row
 * written before a contract addition is still perfectly good history, and
 * re-validating in the browser would blank the panel on exactly the rows the
 * voice route answers from. Every reader below degrades to "not reported".
 */
export type TelemetrySnapshot = Partial<HeartbeatPayload>;

export interface CheckRow {
  id: string;
  checkType: string;
  status: string;
  faultClass: string | null;
  detail: Record<string, unknown> | null;
  checkedAt: string;
}

export interface MachineTelemetry {
  payload: TelemetrySnapshot | null;
  /** `recorded_at`, falling back to the collector's own `collectedAt`. */
  recordedAt: string | null;
  /** Milliseconds since `recordedAt`, or null when nothing has ever arrived. */
  ageMs: number | null;
  stale: boolean;
  checks: CheckRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Heartbeats land every 15–60 seconds. Re-reading the newest row on this
 * cadence keeps an open panel roughly as fresh as the fleet table behind it;
 * without it the workspace silently ages while the operator stares at it,
 * which is the same lie the staleness banner exists to prevent.
 */
const REFETCH_MS = 20_000;

/** Independent of the refetch so the age label counts up between beats. */
const AGE_TICK_MS = 5_000;

/**
 * How far back the fault chain is read. Checks are written per heartbeat per
 * subject (120 printer_chain rows for one machine in a fortnight), so this is
 * a display window, not the whole history.
 */
const CHECK_HISTORY_LIMIT = 120;

export function useMachineTelemetry(assetId: string): MachineTelemetry {
  const [payload, setPayload] = useState<TelemetrySnapshot | null>(null);
  const [recordedAt, setRecordedAt] = useState<string | null>(null);
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    // Both reads are RLS-scoped to the operator's sites, so this hook cannot
    // widen access — it only renders what the session may already read.
    const [telemetry, checkRows] = await Promise.all([
      supabase
        .from("telemetry")
        .select("recorded_at, payload")
        .eq("asset_id", assetId)
        .order("recorded_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("checks")
        .select("id, check_type, status, fault_class, detail, checked_at")
        .eq("asset_id", assetId)
        .order("checked_at", { ascending: false })
        .limit(CHECK_HISTORY_LIMIT),
    ]);

    if (telemetry.error) {
      setError(telemetry.error.message);
      setLoading(false);
      return;
    }

    const row = telemetry.data as { recorded_at: string | null; payload: TelemetrySnapshot | null } | null;
    setPayload(row?.payload ?? null);
    // Same precedence the voice route uses, so both surfaces date a reading
    // from the same instant.
    setRecordedAt(row?.recorded_at ?? row?.payload?.collectedAt ?? null);
    // A failed check read is not a failed panel: the telemetry is the point,
    // and the fault chain is a supporting view that can legitimately be empty.
    setChecks(
      checkRows.error
        ? []
        : (checkRows.data ?? []).map((c) => ({
            id: c.id as string,
            checkType: c.check_type as string,
            status: c.status as string,
            faultClass: (c.fault_class as string | null) ?? null,
            detail: (c.detail as Record<string, unknown> | null) ?? null,
            checkedAt: c.checked_at as string,
          })),
    );
    setError(null);
    setLoading(false);
    setNow(Date.now());
  }, [assetId]);

  useEffect(() => {
    setLoading(true);
    setPayload(null);
    setRecordedAt(null);
    void load();
    const poll = setInterval(() => void load(), REFETCH_MS);
    return () => clearInterval(poll);
  }, [load]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(tick);
  }, []);

  const parsed = recordedAt ? Date.parse(recordedAt) : Number.NaN;
  const ageMs = Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;

  return {
    payload,
    recordedAt,
    ageMs,
    // No telemetry at all counts as stale. "We have never heard from this
    // machine" must not read the same as "we heard from it a second ago".
    stale: ageMs === null || ageMs > STALE_TELEMETRY_MS,
    checks,
    loading,
    error,
    refresh: () => void load(),
  };
}

export interface IncidentRow {
  id: string;
  ticketRef: string | null;
  severity: string;
  title: string;
  category: string | null;
  status: string;
  openedAt: string;
  resolvedAt: string | null;
  resolutionSummary: string | null;
  resolutionSuccess: boolean | null;
  /** False for rows that belong to the branch rather than to this machine. */
  thisMachine: boolean;
}

export interface AlertRow {
  id: string;
  severity: string;
  title: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface CommandRunRow {
  id: string;
  kind: string;
  tier: string;
  scriptId: string | null;
  ticketRef: string | null;
  outcome: string | null;
  refusalReason: string | null;
  exitCode: number | null;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface MachineActivity {
  incidents: IncidentRow[];
  alerts: AlertRow[];
  runs: CommandRunRow[];
  loading: boolean;
  error: string | null;
}

/**
 * The Tickets and History tabs. Kept apart from the telemetry hook because
 * it has a different shelf life: telemetry is a 15-second snapshot, whereas
 * an incident from last month is still the answer to "has this happened
 * before" and does not need re-polling while the panel is open.
 */
export function useMachineActivity(assetId: string): MachineActivity {
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [runs, setRuns] = useState<CommandRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void (async () => {
      const asset = await supabase.from("assets").select("site_id").eq("id", assetId).maybeSingle();
      const siteId = (asset.data as { site_id: string } | null)?.site_id ?? null;

      const incidentColumns =
        "id, ticket_ref, severity, title, category, status, opened_at, resolved_at, resolution_summary, resolution_success";

      const [own, branch, alertRows, runRows] = await Promise.all([
        supabase
          .from("incidents")
          .select(incidentColumns)
          .eq("asset_id", assetId)
          .order("opened_at", { ascending: false })
          .limit(50),
        // Incidents raised against the branch rather than a machine are the
        // recurrence history a new fault here would join. Showing them,
        // clearly labelled as not this machine's, beats an empty tab that
        // implies nothing has ever broken.
        siteId
          ? supabase
              .from("incidents")
              .select(incidentColumns)
              .eq("site_id", siteId)
              .is("asset_id", null)
              .order("opened_at", { ascending: false })
              .limit(25)
          : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
        supabase
          .from("alerts")
          .select("id, severity, title, status, created_at, resolved_at")
          .eq("asset_id", assetId)
          .order("created_at", { ascending: false })
          .limit(50),
        supabase
          .from("command_runs")
          .select("id, kind, tier, script_id, ticket_ref, outcome, refusal_reason, exit_code, duration_ms, created_at, finished_at")
          .eq("asset_id", assetId)
          .order("created_at", { ascending: false })
          .limit(50),
      ]);

      if (cancelled) return;

      const mapIncident = (r: Record<string, unknown>, thisMachine: boolean): IncidentRow => ({
        id: r.id as string,
        ticketRef: (r.ticket_ref as string | null) ?? null,
        severity: (r.severity as string) ?? "unknown",
        title: (r.title as string) ?? "Untitled",
        category: (r.category as string | null) ?? null,
        status: (r.status as string) ?? "unknown",
        openedAt: r.opened_at as string,
        resolvedAt: (r.resolved_at as string | null) ?? null,
        resolutionSummary: (r.resolution_summary as string | null) ?? null,
        resolutionSuccess: (r.resolution_success as boolean | null) ?? null,
        thisMachine,
      });

      setIncidents([
        ...((own.data ?? []) as Record<string, unknown>[]).map((r) => mapIncident(r, true)),
        ...((branch.data ?? []) as Record<string, unknown>[]).map((r) => mapIncident(r, false)),
      ]);
      setAlerts(
        ((alertRows.data ?? []) as Record<string, unknown>[]).map((r) => ({
          id: r.id as string,
          severity: (r.severity as string) ?? "unknown",
          title: (r.title as string) ?? "Untitled",
          status: (r.status as string) ?? "unknown",
          createdAt: r.created_at as string,
          resolvedAt: (r.resolved_at as string | null) ?? null,
        })),
      );
      setRuns(
        ((runRows.data ?? []) as Record<string, unknown>[]).map((r) => ({
          id: r.id as string,
          kind: (r.kind as string) ?? "unknown",
          tier: (r.tier as string) ?? "—",
          scriptId: (r.script_id as string | null) ?? null,
          ticketRef: (r.ticket_ref as string | null) ?? null,
          outcome: (r.outcome as string | null) ?? null,
          refusalReason: (r.refusal_reason as string | null) ?? null,
          exitCode: (r.exit_code as number | null) ?? null,
          durationMs: (r.duration_ms as number | null) ?? null,
          createdAt: r.created_at as string,
          finishedAt: (r.finished_at as string | null) ?? null,
        })),
      );
      setError(own.error?.message ?? alertRows.error?.message ?? runRows.error?.message ?? null);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [assetId]);

  return { incidents, alerts, runs, loading, error };
}

/**
 * Ages round down, never up, for the same reason the voice route's spokenAge
 * does: erring towards "older than it is" is the safe direction when the
 * number decides whether an operator trusts a reading.
 */
export function formatAge(ms: number | null): string {
  if (ms === null) return "never";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

/** Uptime and sync gaps, which read as durations rather than as ages. */
export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
}

/** Volumes and memory are reported in MB; operators read GB. */
export function gib(mb: number | undefined | null): string {
  if (mb === undefined || mb === null) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb / 1024 >= 100 ? 0 : 1)} GB` : `${Math.round(mb)} MB`;
}
