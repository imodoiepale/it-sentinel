"use client";

import type { BranchNode } from "../lib/types";
import { StatusDot } from "./StatusDot";

interface Props {
  branches: BranchNode[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
}

/**
 * Replaces the IP-address list from the old workflow. Grouped, status-dotted,
 * click-through to a branch. This is the object the voice agent's "open
 * <branch>" resolves into — see the pg_trgm matching against sites.name and
 * voice_aliases in the plan.
 */
export function BranchSidebar({ branches, selectedSlug, onSelect }: Props) {
  const total = branches.length;
  const online = branches.filter((b) => b.overallStatus !== "stale" && b.overallStatus !== "unknown").length;
  const critical = branches.filter((b) => b.overallStatus === "critical").length;
  const warning = branches.filter((b) => b.overallStatus === "warning").length;

  return (
    <nav className="w-72 shrink-0 border-r border-white/10 bg-black/20 overflow-y-auto">
      <div className="p-4 border-b border-white/10">
        <div className="text-xs uppercase tracking-wide text-gray-400">Citywalk</div>
        <div className="text-sm mt-1">
          {total} branches · {online} reporting
        </div>
        <div className="flex gap-3 mt-2 text-xs">
          <span className="text-critical">Critical {critical}</span>
          <span className="text-warning">Warning {warning}</span>
        </div>
      </div>
      <ul>
        {branches.map((b) => (
          <li key={b.siteId}>
            <button
              onClick={() => onSelect(b.slug)}
              className={`w-full text-left px-4 py-2.5 flex items-center justify-between hover:bg-white/5 border-b border-white/5 ${
                selectedSlug === b.slug ? "bg-white/10" : ""
              }`}
            >
              <span className="flex flex-col">
                <span className="text-sm">{b.name}</span>
                <span className="text-[11px] text-gray-500">
                  {b.assets.length} machine{b.assets.length === 1 ? "" : "s"} · {b.region}
                </span>
              </span>
              <StatusDot status={b.overallStatus} label={`${b.name}: ${b.overallStatus}`} />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
