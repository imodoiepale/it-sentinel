"use client";

import { formatTimestamp, type CheckRow } from "../../lib/useMachineTelemetry";
import { EmptyResult, Pill, Scroller, TD, TH, TR } from "./ui";

/**
 * The fault chain: what the control plane concluded about this machine on
 * each pass, as opposed to what the machine reported about itself. Shared by
 * the Printers tab (its own check type) and History (all of them).
 */

function checkTone(status: string) {
  if (status === "healthy" || status === "ok" || status === "pass") return "ok" as const;
  if (status === "warning" || status === "degraded") return "warn" as const;
  if (status === "unknown") return "muted" as const;
  return "bad" as const;
}

/** Check details are free-form jsonb; render whatever scalars are in there. */
function summariseDetail(detail: Record<string, unknown> | null): string {
  if (!detail) return "";
  return Object.entries(detail)
    .filter(([, v]) => v !== null && typeof v !== "object")
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(" · ");
}

export function CheckHistory({ checks, emptyText }: { checks: CheckRow[]; emptyText: string }) {
  if (checks.length === 0) return <EmptyResult>{emptyText}</EmptyResult>;

  return (
    <Scroller max="max-h-80">
      <table className="w-full text-sm">
        <caption className="sr-only">Check results recorded against this machine, newest first</caption>
        <thead>
          <tr className="border-b border-white/10">
            <th scope="col" className={TH}>
              When
            </th>
            <th scope="col" className={TH}>
              Check
            </th>
            <th scope="col" className={TH}>
              Result
            </th>
            <th scope="col" className={TH}>
              Detail
            </th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.id} className={TR}>
              <td className={`${TD} text-muted whitespace-nowrap`}>{formatTimestamp(c.checkedAt)}</td>
              <td className={`${TD} text-gray-300`}>{c.checkType.replace(/_/g, " ")}</td>
              <td className={TD}>
                <Pill tone={checkTone(c.status)}>{c.status}</Pill>
                {/* faultClass "none" is not a fault, so it is not rendered as
                    one — showing it would read as a second status word. */}
                {c.faultClass && c.faultClass !== "none" && (
                  <span className="ml-1.5 text-xs text-warning">{c.faultClass.replace(/_/g, " ")}</span>
                )}
              </td>
              <td className={`${TD} text-muted`}>{summariseDetail(c.detail) || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroller>
  );
}
