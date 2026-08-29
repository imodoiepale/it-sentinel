"use client";

import type { CheckRow, TelemetrySnapshot } from "../../lib/useMachineTelemetry";
import { CheckHistory } from "./CheckHistory";
import { EmptyResult, Flag, Pill, Scroller, Section, TabBody, TD, TH, TR, Wide } from "./ui";

/**
 * Printers, plus the printer_chain check history behind them. The fault
 * judgement matches the voice route's: a printer is a problem when it is
 * offline or carries a fault class, and a non-empty queue on a healthy
 * printer is worth showing but is not itself a fault.
 */
export function PrintersTab({ payload, checks }: { payload: TelemetrySnapshot; checks: CheckRow[] }) {
  const printers = payload.printers ?? [];
  const faulty = printers.filter((p) => !p.online || p.faultClass !== "none");
  const queued = printers.filter((p) => p.online && p.faultClass === "none" && p.queueDepth > 0);
  const printerChecks = checks.filter((c) => c.checkType.includes("printer"));

  return (
    <TabBody>
      <Wide>
        <Section
          title="Installed printers"
          aside={
            <span className="text-xs text-muted">
              {printers.length} installed · {faulty.length} faulting
            </span>
          }
        >
          {printers.length === 0 ? (
            <EmptyResult>No printers are installed on this machine.</EmptyResult>
          ) : (
            <>
              {faulty.length > 0 ? (
                <Flag tone="bad">
                  {faulty
                    .map((p) => {
                      const bits = [p.online ? "online but faulting" : "offline"];
                      if (p.faultClass !== "none") bits.push(p.faultClass.replace(/_/g, " "));
                      if (p.queueDepth > 0) bits.push(`${p.queueDepth} job${p.queueDepth === 1 ? "" : "s"} queued`);
                      if (p.errorState) bits.push(p.errorState);
                      return `${p.name}: ${bits.join(", ")}`;
                    })
                    .join("; ")}
                </Flag>
              ) : queued.length > 0 ? (
                <Flag tone="warn">
                  Nothing is faulting, but {queued.map((p) => `${p.name} has ${p.queueDepth} job${p.queueDepth === 1 ? "" : "s"} waiting`).join(" and ")}.
                </Flag>
              ) : (
                <Flag tone="ok">All {printers.length} printers are online with empty queues.</Flag>
              )}

              <Scroller>
                <table className="w-full text-sm">
                  <caption className="sr-only">Printers installed on this machine</caption>
                  <thead>
                    <tr className="border-b border-line">
                      <th scope="col" className={TH}>
                        Printer
                      </th>
                      <th scope="col" className={TH}>
                        State
                      </th>
                      <th scope="col" className={`${TH} text-right`}>
                        Queue
                      </th>
                      <th scope="col" className={TH}>
                        Driver
                      </th>
                      <th scope="col" className={TH}>
                        Port
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...printers]
                      .sort((a, b) => {
                        const bad = (p: typeof a) => (!p.online || p.faultClass !== "none" ? 0 : p.queueDepth > 0 ? 1 : 2);
                        return bad(a) - bad(b) || a.name.localeCompare(b.name);
                      })
                      .map((p) => (
                        <tr key={p.name} className={TR}>
                          <th scope="row" className={`${TD} font-normal text-left text-ink-soft`}>
                            {p.name}
                            {p.isDefault && <span className="ml-2 text-xs text-muted">default</span>}
                          </th>
                          <td className={TD}>
                            <Pill tone={!p.online ? "bad" : p.faultClass !== "none" ? "warn" : "ok"}>
                              {p.online ? "online" : "offline"}
                            </Pill>
                            {p.faultClass !== "none" && (
                              <span className="ml-1.5 text-xs text-warning-ink">{p.faultClass.replace(/_/g, " ")}</span>
                            )}
                            {p.errorState && <span className="block text-xs text-critical-ink">{p.errorState}</span>}
                          </td>
                          <td className={`${TD} text-right tabular-nums ${p.queueDepth > 0 ? "text-warning-ink" : "text-muted"}`}>
                            {p.queueDepth > 0 && <span className="sr-only">Warning: </span>}
                            {p.queueDepth}
                          </td>
                          <td className={`${TD} text-muted`}>{p.driver ?? "—"}</td>
                          {/* Ports on packaged apps are 200-character package
                              identifiers; they are truncated rather than
                              allowed to set the table's width. */}
                          <td className={`${TD} text-muted font-mono text-xs max-w-[16rem] truncate`} title={p.port}>
                            {p.port ?? "—"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </Scroller>
            </>
          )}
        </Section>

        <Section
          title="Printer check history"
          hint="What the control plane concluded on each pass, which is what alerting and recurrence are built on."
        >
          <CheckHistory checks={printerChecks} emptyText="No printer checks have been recorded for this machine yet." />
        </Section>
      </Wide>
    </TabBody>
  );
}
