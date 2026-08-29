"use client";

import { formatTimestamp, type TelemetrySnapshot } from "../../lib/useMachineTelemetry";
import { EmptyResult, Flag, Pill, Scroller, Section, TabBody, TD, TH, TR, Wide } from "./ui";

/**
 * Windows event log entries carried in the heartbeat.
 *
 * The collector scans a fifteen-minute window of the Application and System
 * logs for critical and error entries, capped at twenty. An empty list is a
 * real answer — nothing bad happened in that window — but it is emphatically
 * not "this machine has no errors", and this tab has to say which.
 */
export function LogsTab({ payload }: { payload: TelemetrySnapshot }) {
  const events = payload.recentEvents ?? [];
  const critical = events.filter((e) => e.level === "critical");

  return (
    <TabBody>
      <Wide>
        <Section
          title="Recent event log"
          hint="Critical and error entries from the Application and System logs, as of the heartbeat above. The collector looks back fifteen minutes and sends at most twenty entries, so this is a rolling window, not the machine's event history."
          aside={<span className="text-xs text-muted">{events.length} entr{events.length === 1 ? "y" : "ies"}</span>}
        >
          {events.length === 0 ? (
            <>
              <Flag tone="ok">No critical or error events in the window the collector last scanned.</Flag>
              <EmptyResult>
                To read further back than that window, use the Terminal tab —{" "}
                <code className="font-mono text-xs">Get-WinEvent</code> on the machine sees the full logs.
                Nothing in IT Sentinel archives them.
              </EmptyResult>
            </>
          ) : (
            <>
              {critical.length > 0 && (
                <Flag tone="bad">
                  {critical.length} critical event{critical.length === 1 ? "" : "s"} in the last window, from{" "}
                  {[...new Set(critical.map((e) => e.source))].join(", ")}.
                </Flag>
              )}
              <Scroller max="max-h-96">
                <table className="w-full text-sm">
                  <caption className="sr-only">Recent critical and error events from the Windows event log</caption>
                  <thead>
                    <tr className="border-b border-white/10">
                      <th scope="col" className={TH}>
                        When
                      </th>
                      <th scope="col" className={TH}>
                        Level
                      </th>
                      <th scope="col" className={TH}>
                        Source
                      </th>
                      <th scope="col" className={TH}>
                        Event
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e, i) => (
                      // Source + event id + timestamp is not unique when the
                      // collector collapses repeats, so the index carries the
                      // key; the list is a fixed snapshot and never reorders.
                      <tr key={`${e.source}-${e.eventId ?? "x"}-${e.occurredAt}-${i}`} className={TR}>
                        <td className={`${TD} text-muted whitespace-nowrap`}>{formatTimestamp(e.occurredAt)}</td>
                        <td className={TD}>
                          <Pill tone={e.level === "critical" ? "bad" : e.level === "error" ? "warn" : "muted"}>
                            {e.level}
                          </Pill>
                        </td>
                        <td className={`${TD} text-gray-300`}>
                          {e.source}
                          {e.eventId !== undefined && <span className="block text-xs text-muted">ID {e.eventId}</span>}
                        </td>
                        <td className={`${TD} text-gray-300`}>
                          {e.message}
                          {e.count > 1 && <span className="ml-2 text-xs text-warning">×{e.count}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroller>
            </>
          )}
        </Section>
      </Wide>
    </TabBody>
  );
}
