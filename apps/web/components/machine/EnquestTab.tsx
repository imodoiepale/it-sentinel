"use client";

import { formatAge, formatTimestamp, type TelemetrySnapshot } from "../../lib/useMachineTelemetry";
import { EmptyResult, Facts, Flag, NotCollected, Section, TabBody, Wide, type Tone } from "./ui";

/**
 * Enquest, the line-of-business application the fleet is watched for.
 *
 * The careful part here is the difference between "probed and false" and
 * "never probed". The Windows collector detects whether the process is
 * running and reports the database and sync flags as false without testing
 * either — it sets status to "unknown" when it has not evaluated the app.
 * Rendering those flags as red failures would invent an outage. So when the
 * app is absent or the status is unknown, the unprobed fields say so rather
 * than reporting a health they do not know.
 */
export function EnquestTab({ payload }: { payload: TelemetrySnapshot }) {
  const e = payload.enquestDetail;

  if (!e) {
    return (
      <TabBody>
        <Wide>
          <Section title="Enquest">
            <EmptyResult>This heartbeat carried no Enquest section.</EmptyResult>
          </Section>
        </Wide>
      </TabBody>
    );
  }

  const unevaluated = e.status === "unknown";
  const probed = (value: boolean, whenTrue: string, whenFalse: string): { value: string; tone: Tone } =>
    unevaluated
      ? { value: "not probed", tone: "muted" }
      : { value: value ? whenTrue : whenFalse, tone: value ? "ok" : "bad" };

  const dbField = probed(e.databaseReachable, "reachable", "unreachable");
  const syncField = probed(e.syncServiceRunning, "running", "stopped");

  return (
    <TabBody>
      <Wide>
        <Section title="Enquest">
          {!e.installed ? (
            <Flag tone="muted">Enquest is not installed on this machine.</Flag>
          ) : unevaluated ? (
            <Flag tone="warn">
              Enquest is installed, but this collector did not evaluate its health — the status it sent is
              &ldquo;unknown&rdquo;, not &ldquo;healthy&rdquo;.
            </Flag>
          ) : e.status === "healthy" ? (
            <Flag tone="ok">Enquest is healthy.</Flag>
          ) : (
            <Flag tone="bad">Enquest is {e.status}.</Flag>
          )}

          <Facts
            items={[
              { label: "Installed", value: e.installed ? "yes" : "no", tone: e.installed ? "ok" : "muted" },
              {
                label: "Process running",
                value: e.processRunning ? "yes" : "no",
                tone: e.processRunning ? "ok" : e.installed ? "bad" : "muted",
              },
              { label: "Database", value: dbField.value, tone: dbField.tone },
              { label: "Sync service", value: syncField.value, tone: syncField.tone },
              {
                label: "Version",
                value: e.version ?? "not reported",
                tone: e.version ? "plain" : "muted",
              },
              {
                label: "Last successful sync",
                value: e.lastSuccessfulSyncAt
                  ? `${formatTimestamp(e.lastSuccessfulSyncAt)} (${formatAge(Date.now() - Date.parse(e.lastSuccessfulSyncAt))} ago)`
                  : "not reported",
                tone: e.lastSuccessfulSyncAt ? "plain" : "muted",
              },
              {
                label: "Recent errors",
                value: e.recentErrorCount,
                tone: e.recentErrorCount > 0 ? "warn" : "ok",
                note: e.mostCommonError ? `Most common: ${e.mostCommonError}` : undefined,
              },
              {
                label: "Pending requisitions",
                value: e.pendingRequisitions ?? "not reported",
                tone: e.pendingRequisitions === undefined ? "muted" : "plain",
              },
              {
                label: "Pending deliveries",
                value: e.pendingDeliveries ?? "not reported",
                tone: e.pendingDeliveries === undefined ? "muted" : "plain",
              },
            ]}
          />
        </Section>

        {(unevaluated || !e.installed) && (
          <NotCollected heading="No Enquest probe runs on this machine yet.">
            <p>
              The Windows collector checks for a running <code className="font-mono text-xs">Enquest</code>{" "}
              process and nothing else. It does not open the Enquest database, query the sync service, read
              a version, or count requisitions — the contract has slots for all of them and no heartbeat
              from this fleet has ever carried one.
            </p>
            <p>
              That is why the fields above read &ldquo;not probed&rdquo; rather than showing failures. An
              unreachable database and an untested one look identical in the raw payload, and only one of
              them is worth waking someone up for.
            </p>
          </NotCollected>
        )}
      </Wide>
    </TabBody>
  );
}
