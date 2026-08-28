import { db } from "../db.js";

/**
 * "Junction POS-02 has had this problem six times this month, previous fix
 * restart-spooler succeeded 92% of the time" — this is the module that
 * makes that possible instead of the technician starting from zero.
 */

export interface SimilarIncident {
  ticketRef: string | null;
  title: string;
  resolutionSummary: string | null;
  resolutionSuccess: boolean | null;
  openedAt: string;
}

export interface RecurrenceReport {
  timesSeen: number;
  similarIncidents: SimilarIncident[];
  suggestedFix: string | null;
  successRatePercent: number | null;
}

export async function getRecurrence(fingerprint: string, limit = 5): Promise<RecurrenceReport> {
  const { data, error } = await db
    .from("incidents")
    .select("ticket_ref, title, resolution_summary, resolution_success, opened_at")
    .eq("fingerprint", fingerprint)
    .eq("status", "resolved")
    .order("opened_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const incidents = data ?? [];
  const resolved = incidents.filter((i) => i.resolution_success !== null);
  const succeeded = resolved.filter((i) => i.resolution_success === true);

  const mostRecentFix = incidents.find((i) => i.resolution_success)?.resolution_summary ?? null;

  return {
    timesSeen: incidents.length,
    similarIncidents: incidents.map((i) => ({
      ticketRef: i.ticket_ref,
      title: i.title,
      resolutionSummary: i.resolution_summary,
      resolutionSuccess: i.resolution_success,
      openedAt: i.opened_at,
    })),
    suggestedFix: mostRecentFix,
    successRatePercent: resolved.length > 0 ? Math.round((succeeded.length / resolved.length) * 100) : null,
  };
}

/**
 * Fingerprint an alert into a stable dedup/recurrence key.
 *
 * Per-MACHINE by design: assetId is in the middle so that an open alert at
 * one branch never deduplicates an identical fault at another. That also
 * means it cannot answer "has this been seen elsewhere" — use
 * getClassRecurrence() below for that, which drops the assetId segment.
 */
export function fingerprintFor(checkType: string, assetId: string, faultClass?: string | null): string {
  return faultClass ? `${checkType}:${assetId}:${faultClass}` : `${checkType}:${assetId}`;
}

export async function openIncidentFromAlert(alertId: string) {
  const { data: alert, error: alertError } = await db.from("alerts").select("*").eq("id", alertId).single();
  if (alertError) throw alertError;

  const recurrence = await getRecurrence(alert.fingerprint);

  const { data: incident, error: insertError } = await db
    .from("incidents")
    .insert({
      asset_id: alert.asset_id,
      site_id: alert.site_id,
      fingerprint: alert.fingerprint,
      severity: alert.severity,
      title: alert.title,
      status: "open",
    })
    .select()
    .single();
  if (insertError) throw insertError;

  await db.from("incident_events").insert({
    incident_id: incident.id,
    event_type: "created",
    detail: {
      from_alert: alertId,
      times_seen_before: recurrence.timesSeen,
      suggested_fix: recurrence.suggestedFix,
      historical_success_rate: recurrence.successRatePercent,
    },
  });

  return { incident, recurrence };
}

/** Cause analytics for the morning report: "Enquest sync 31%, printer queues 22%..." */
export async function getIncidentCauseBreakdown(sinceIso: string) {
  const { data, error } = await db.from("incidents").select("category").gte("opened_at", sinceIso);
  if (error) throw error;

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const key = row.category ?? "other";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = data?.length ?? 0;
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count, percent: total > 0 ? Math.round((count / total) * 100) : 0 }))
    .sort((a, b) => b.count - a.count);
}

/**
 * The class-level half of the same question.
 *
 * fingerprintFor() puts assetId in the middle, which makes a fingerprint
 * identify a fault ON ONE MACHINE. That is the correct key for dedup —
 * raiseAlert() must not suppress Lagos's Enquest alert because Nairobi
 * already has one open — but it is the wrong key for "has anyone seen this
 * before", because the two branches hitting the identical failure produce
 * two fingerprints and getRecurrence() sees neither in the other's history.
 *
 * So this matches on the segments that are NOT the machine: the check type,
 * and the fault class when there is one. Same question, fleet-wide scope.
 */

export interface ClassIncident extends SimilarIncident {
  branch: string | null;
  assetId: string | null;
}

export interface BranchOccurrence {
  branch: string;
  count: number;
}

export interface FixHistory {
  /**
   * resolution_summary matched verbatim. Two technicians who type the same
   * fix differently count as two fixes — which understates a fix's track
   * record rather than overstating it, and that is the direction to be
   * wrong in when the number gets read out as advice.
   */
  fix: string;
  attempts: number;
  succeeded: number;
}

export interface ClassRecurrenceReport {
  checkType: string;
  faultClass: string | null;
  timesSeen: number;
  assetsAffected: number;
  /** Descending by count, so the worst-affected branch is spoken first. */
  branches: BranchOccurrence[];
  incidents: ClassIncident[];
  suggestedFix: string | null;
  /** Attempts and successes for suggestedFix alone, not for the class. */
  suggestedFixHistory: FixHistory | null;
  successRatePercent: number | null;
}

export async function getClassRecurrence(
  checkType: string,
  faultClass?: string | null,
  limit = 20,
): Promise<ClassRecurrenceReport> {
  let q = db
    .from("incidents")
    .select("ticket_ref, title, resolution_summary, resolution_success, opened_at, asset_id, fingerprint, sites(name)")
    // A prefix match on the fingerprint rather than a check_type column:
    // incidents only stores the composite key, and adding the column would
    // need a migration plus a backfill for rows already written. The
    // patterns are built from an allowlist or from a fingerprint already in
    // the database, never from free text — `%` in a caller-supplied
    // checkType would silently widen this to every check there is.
    .like("fingerprint", `${checkType}:%`)
    .eq("status", "resolved")
    .order("opened_at", { ascending: false })
    .limit(limit);
  if (faultClass) q = q.like("fingerprint", `%:${faultClass}`);

  const { data, error } = await q;
  if (error) throw error;

  const rows = (data ?? []) as any[];
  const incidents: ClassIncident[] = rows.map((i) => ({
    ticketRef: i.ticket_ref,
    title: i.title,
    resolutionSummary: i.resolution_summary,
    resolutionSuccess: i.resolution_success,
    openedAt: i.opened_at,
    assetId: i.asset_id ?? null,
    // PostgREST returns an embedded to-one as an object, but the generated
    // types (and some client versions) hand back a single-element array.
    branch: (Array.isArray(i.sites) ? i.sites[0]?.name : i.sites?.name) ?? null,
  }));

  const branchCounts = new Map<string, number>();
  for (const i of incidents) {
    if (!i.branch) continue;
    branchCounts.set(i.branch, (branchCounts.get(i.branch) ?? 0) + 1);
  }

  const graded = incidents.filter((i) => i.resolutionSuccess !== null);
  const suggestedFix = incidents.find((i) => i.resolutionSuccess && i.resolutionSummary)?.resolutionSummary ?? null;
  const forSuggested = suggestedFix ? graded.filter((i) => i.resolutionSummary === suggestedFix) : [];

  return {
    checkType,
    faultClass: faultClass ?? null,
    timesSeen: incidents.length,
    assetsAffected: new Set(incidents.map((i) => i.assetId).filter(Boolean)).size,
    branches: [...branchCounts.entries()]
      .map(([branch, count]) => ({ branch, count }))
      .sort((a, b) => b.count - a.count),
    incidents,
    suggestedFix,
    suggestedFixHistory: suggestedFix
      ? {
          fix: suggestedFix,
          attempts: forSuggested.length,
          succeeded: forSuggested.filter((i) => i.resolutionSuccess === true).length,
        }
      : null,
    successRatePercent:
      graded.length > 0
        ? Math.round((graded.filter((i) => i.resolutionSuccess === true).length / graded.length) * 100)
        : null,
  };
}
