"use client";

import type { TelemetrySnapshot } from "../../lib/useMachineTelemetry";
import { EmptyResult, Flag, Pill, Scroller, Section, TabBody, TD, TH, TR, Wide } from "./ui";

/**
 * Windows services, as the collector's watchlist reports them. Matches the
 * voice route's judgement exactly: a service is a problem when it is
 * expected to be running and is not. Anything with expectedState "any" is
 * being watched, not policed, and is never a fault on its own.
 */
export function ServicesTab({ payload }: { payload: TelemetrySnapshot }) {
  const services = payload.services ?? [];
  const down = services.filter((s) => s.expectedState === "running" && s.actualState !== "running");

  return (
    <TabBody>
      <Wide>
        <Section
          title="Monitored services"
          hint="Only the services on the collector's watchlist appear here — this is not the machine's full service list."
          aside={
            <span className="text-xs text-muted">
              {services.length} watched · {down.length} not in their expected state
            </span>
          }
        >
          {services.length === 0 ? (
            <EmptyResult>This heartbeat carried no service states.</EmptyResult>
          ) : (
            <>
              {down.length > 0 ? (
                <Flag tone="bad">
                  {down.length === 1
                    ? `${down[0]!.name} should be running and is ${down[0]!.actualState}.`
                    : `${down.length} services should be running and are not: ${down.map((s) => s.name).join(", ")}.`}
                </Flag>
              ) : (
                <Flag tone="ok">All {services.length} watched services are in their expected state.</Flag>
              )}

              <Scroller>
                <table className="w-full text-sm">
                  <caption className="sr-only">Watched Windows services and their states</caption>
                  <thead>
                    <tr className="border-b border-white/10">
                      <th scope="col" className={TH}>
                        Service
                      </th>
                      <th scope="col" className={TH}>
                        Expected
                      </th>
                      <th scope="col" className={TH}>
                        Actual
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Violations first: the operator is looking for the one
                        bad row, not reading an alphabetical list. */}
                    {[...services]
                      .sort((a, b) => {
                        const bad = (s: typeof a) => (s.expectedState === "running" && s.actualState !== "running" ? 0 : 1);
                        return bad(a) - bad(b) || a.name.localeCompare(b.name);
                      })
                      .map((s) => {
                        const violating = s.expectedState === "running" && s.actualState !== "running";
                        return (
                          <tr key={s.name} className={TR}>
                            <th scope="row" className={`${TD} font-normal text-left ${violating ? "text-critical-ink" : "text-gray-200"}`}>
                              {s.name}
                            </th>
                            <td className={`${TD} text-muted`}>{s.expectedState}</td>
                            <td className={TD}>
                              <Pill tone={violating ? "bad" : s.actualState === "unknown" ? "muted" : "ok"}>
                                {s.actualState}
                              </Pill>
                            </td>
                          </tr>
                        );
                      })}
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
