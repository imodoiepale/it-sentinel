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

/** Fingerprint an alert into a stable dedup/recurrence key. */
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
