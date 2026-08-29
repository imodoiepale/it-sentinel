"use client";

import { formatTimestamp, type CheckRow, type MachineActivity } from "../../lib/useMachineTelemetry";
import { CheckHistory } from "./CheckHistory";
import { EmptyResult, Pill, Scroller, Section, TabBody, TD, TH, TR, Wide } from "./ui";

function outcomeTone(outcome: string | null) {
  if (outcome === "success" || outcome === "ok") return "ok" as const;
  if (outcome === "refused" || outcome === "denied") return "warn" as const;
  if (outcome === null) return "muted" as const;
  return "bad" as const;
}

/**
 * What has been done to this machine, and what the platform has concluded
 * about it. Command runs first: when a technician asks "what changed", a
 * remediation someone dispatched twenty minutes ago is the answer far more
 * often than a check result is.
 */
export function HistoryTab({ activity, checks }: { activity: MachineActivity; checks: CheckRow[] }) {
  const { runs, loading, error } = activity;

  return (
    <TabBody>
      <Wide>
        <Section
          title="Commands run on this machine"
          hint="Every action dispatched through the orchestrator, whether it ran or was refused."
          aside={<span className="text-xs text-muted">{runs.length} recorded</span>}
        >
          {loading ? (
            <EmptyResult>Loading…</EmptyResult>
          ) : error ? (
            <p role="status" className="text-sm text-critical-ink">
              <span className="sr-only">Error: </span>
              Could not read command history: {error}
            </p>
          ) : runs.length === 0 ? (
            <EmptyResult>No commands have been dispatched to this machine.</EmptyResult>
          ) : (
            <Scroller>
              <table className="w-full text-sm">
                <caption className="sr-only">Commands dispatched to this machine, newest first</caption>
                <thead>
                  <tr className="border-b border-line">
                    <th scope="col" className={TH}>
                      When
                    </th>
                    <th scope="col" className={TH}>
                      Action
                    </th>
                    <th scope="col" className={TH}>
                      Tier
                    </th>
                    <th scope="col" className={TH}>
                      Outcome
                    </th>
                    <th scope="col" className={TH}>
                      Ticket
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className={TR}>
                      <td className={`${TD} text-muted whitespace-nowrap`}>{formatTimestamp(r.createdAt)}</td>
                      <td className={`${TD} text-ink-soft`}>
                        {r.kind}
                        {r.scriptId && <span className="block font-mono text-xs text-muted">{r.scriptId}</span>}
                      </td>
                      <td className={`${TD} text-muted`}>{r.tier}</td>
                      <td className={TD}>
                        <Pill tone={outcomeTone(r.outcome)}>{r.outcome ?? "no result"}</Pill>
                        {r.refusalReason && <span className="block text-xs text-warning-ink">{r.refusalReason}</span>}
                        {r.exitCode !== null && r.exitCode !== 0 && (
                          <span className="block text-xs text-critical-ink">exit {r.exitCode}</span>
                        )}
                        {r.durationMs !== null && (
                          <span className="block text-xs text-muted">{(r.durationMs / 1000).toFixed(1)}s</span>
                        )}
                      </td>
                      <td className={`${TD} font-mono text-xs text-muted`}>{r.ticketRef ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          )}
        </Section>

        <Section
          title="Check history"
          hint="One row per subject per pass. This is the raw chain alerting and recurrence are derived from, not a summary of it."
        >
          <CheckHistory checks={checks} emptyText="No checks have been recorded for this machine yet." />
        </Section>
      </Wide>
    </TabBody>
  );
}
