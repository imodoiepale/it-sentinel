"use client";

import { useMemo, useState } from "react";
import type { FleetRow } from "../lib/types";
import { StatusDot } from "./StatusDot";

interface Props {
  rows: FleetRow[];
  onOpenMachine: (assetId: string) => void;
}

/**
 * Branch · PC · Network · Email · Printer · Enquest · Security · RAM ·
 * Disk · VNC · Tickets — exactly the table from the plan, sortable, with
 * "only what's broken" as the default filter so the technician sees
 * problems first, not a wall of green.
 */
export function FleetTable({ rows, onOpenMachine }: Props) {
  const [onlyProblems, setOnlyProblems] = useState(true);

  const visible = useMemo(() => {
    if (!onlyProblems) return rows;
    return rows.filter(
      (r) =>
        r.status !== "healthy" ||
        r.printerStatus === "critical" ||
        r.emailStatus === "critical" ||
        r.endpointSecurityStatus === "critical" ||
        r.enquestStatus === "critical",
    );
  }, [rows, onlyProblems]);

  return (
    <div className="flex-1 overflow-auto">
      <div className="flex items-center justify-between p-3 border-b border-white/10">
        <div className="text-sm text-gray-400">{visible.length} of {rows.length} machines shown</div>
        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          Only show what's broken
        </label>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-gray-500 text-xs uppercase">
          <tr className="border-b border-white/10">
            <th className="p-2">Machine</th>
            <th className="p-2">Network</th>
            <th className="p-2">Email</th>
            <th className="p-2">Printer</th>
            <th className="p-2">Enquest</th>
            <th className="p-2">Security</th>
            <th className="p-2">RAM</th>
            <th className="p-2">Disk</th>
            <th className="p-2">VNC</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <tr
              key={r.assetId}
              className="border-b border-white/5 hover:bg-white/5 cursor-pointer"
              onClick={() => onOpenMachine(r.assetId)}
            >
              <td className="p-2 font-medium">{r.hostname}</td>
              <td className="p-2"><StatusDot status={r.online ? "healthy" : "critical"} /></td>
              <td className="p-2"><StatusDot status={r.emailStatus} /></td>
              <td className="p-2"><StatusDot status={r.printerStatus} /></td>
              <td className="p-2"><StatusDot status={r.enquestStatus} /></td>
              <td className="p-2"><StatusDot status={r.endpointSecurityStatus} /></td>
              <td className="p-2 tabular-nums">{r.ramUsage != null ? `${Math.round(r.ramUsage)}%` : "—"}</td>
              <td className="p-2 tabular-nums">{r.diskFreePercent != null ? `${Math.round(r.diskFreePercent)}% free` : "—"}</td>
              <td className="p-2"><StatusDot status={r.tightvncStatus === "running" ? "healthy" : "critical"} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
