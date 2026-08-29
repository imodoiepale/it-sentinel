"use client";

import { formatTimestamp, type MachineActivity } from "../../lib/useMachineTelemetry";
import { EmptyResult, Flag, Pill, Scroller, Section, TabBody, TD, TH, TR, Wide } from "./ui";

function severityTone(severity: string) {
  if (severity === "p1" || severity === "critical") return "bad" as const;
  if (severity === "p2" || severity === "warning") return "warn" as const;
  return "muted" as const;
}

/**
 * Incidents and alerts. Open work first, then the machine's own resolved
 * history, then the branch's — a fault here is far more likely to be a
 * repeat of something that happened at this branch than a novel one, and
 * recurrence.service.ts groups by fingerprint for exactly that reason.
 */
export function TicketsTab({ activity }: { activity: MachineActivity }) {
  const { incidents, alerts, loading, error } = activity;
  const mine = incidents.filter((i) => i.thisMachine);
  const branch = incidents.filter((i) => !i.thisMachine);
  const openIncidents = mine.filter((i) => i.status !== "resolved" && i.status !== "closed");
  const openAlerts = alerts.filter((a) => a.status !== "resolved" && a.status !== "closed");

  if (loading) {
    return (
      <TabBody>
        <Wide>
          <Section title="Tickets">
            <EmptyResult>Loading…</EmptyResult>
          </Section>
        </Wide>
      </TabBody>
    );
  }

  if (error) {
    return (
      <TabBody>
        <Wide>
          <Section title="Tickets">
            <p role="status" className="text-sm text-critical-ink">
              <span className="sr-only">Error: </span>
              Could not read tickets: {error}
            </p>
          </Section>
        </Wide>
      </TabBody>
    );
  }

  return (
    <TabBody>
      <Wide>
        <Section
          title="Open now"
          aside={
            <span className="text-xs text-muted">
              {openIncidents.length} incident{openIncidents.length === 1 ? "" : "s"} · {openAlerts.length} alert
              {openAlerts.length === 1 ? "" : "s"}
            </span>
          }
        >
          {openIncidents.length === 0 && openAlerts.length === 0 ? (
            <Flag tone="ok">Nothing open against this machine.</Flag>
          ) : (
            <ul className="space-y-2 text-sm">
              {openAlerts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-baseline gap-2">
                  <Pill tone={severityTone(a.severity)}>{a.severity}</Pill>
                  <span className="text-gray-200">{a.title}</span>
                  <span className="text-xs text-muted">alert, raised {formatTimestamp(a.createdAt)}</span>
                </li>
              ))}
              {openIncidents.map((i) => (
                <li key={i.id} className="flex flex-wrap items-baseline gap-2">
                  <Pill tone={severityTone(i.severity)}>{i.severity}</Pill>
                  <span className="text-gray-200">{i.title}</span>
                  {i.ticketRef && <span className="font-mono text-xs text-muted">{i.ticketRef}</span>}
                  <span className="text-xs text-muted">opened {formatTimestamp(i.openedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="This machine's incident history">
          <IncidentTable
            rows={mine}
            empty="No incident has ever been raised against this machine specifically."
          />
        </Section>

        <Section
          title="Branch history"
          hint="Incidents recorded against this machine's branch rather than against a machine. They are not this machine's faults, but they are what a repeat here would be measured against."
        >
          <IncidentTable rows={branch} empty="No incidents recorded at this branch." />
        </Section>
      </Wide>
    </TabBody>
  );
}

function IncidentTable({ rows, empty }: { rows: MachineActivity["incidents"]; empty: string }) {
  if (rows.length === 0) return <EmptyResult>{empty}</EmptyResult>;
  return (
    <Scroller>
      <table className="w-full text-sm">
        <caption className="sr-only">Incidents, newest first</caption>
        <thead>
          <tr className="border-b border-white/10">
            <th scope="col" className={TH}>
              Opened
            </th>
            <th scope="col" className={TH}>
              Ticket
            </th>
            <th scope="col" className={TH}>
              Title
            </th>
            <th scope="col" className={TH}>
              Status
            </th>
            <th scope="col" className={TH}>
              Fix
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.id} className={TR}>
              <td className={`${TD} text-muted whitespace-nowrap`}>{formatTimestamp(i.openedAt)}</td>
              <td className={`${TD} font-mono text-xs text-muted`}>{i.ticketRef ?? "—"}</td>
              <td className={`${TD} text-gray-200`}>
                {i.title}
                {i.category && <span className="block text-xs text-muted">{i.category}</span>}
              </td>
              <td className={TD}>
                <Pill tone={i.status === "resolved" || i.status === "closed" ? "ok" : severityTone(i.severity)}>
                  {i.status}
                </Pill>
              </td>
              <td className={`${TD} text-muted`}>
                {i.resolutionSummary ?? "—"}
                {/* resolutionSuccess is nullable and false is meaningful, so
                    it is only rendered when the column actually holds one. */}
                {i.resolutionSuccess === false && (
                  <span className="block text-xs text-warning">
                    <span className="sr-only">Warning: </span>
                    did not hold
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroller>
  );
}
