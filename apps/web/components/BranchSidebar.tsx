"use client";

import type { BranchNode } from "../lib/types";
import { StatusDot } from "./StatusDot";

interface Props {
  branches: BranchNode[];
  selectedSlug: string | null;
  onSelect: (slug: string | null) => void;
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

  const machineCount = branches.reduce((n, b) => n + b.assets.length, 0);

  return (
    <nav className="w-72 shrink-0 border-r border-white/10 bg-[#080b0f] overflow-y-auto">
      <div className="p-4 border-b border-white/10">
        <div className="text-[11px] font-medium uppercase tracking-wider text-gray-500">Sentinel Global</div>
        <div className="text-sm mt-1 text-gray-200">
          {total} branches · {online} reporting
        </div>
        <p className="mt-0.5 text-[11px] text-muted">{machineCount} machines</p>
        <div className="flex gap-3 mt-3 text-xs">
          <span className="text-critical-ink">Critical {critical}</span>
          <span className="text-warning">Warning {warning}</span>
        </div>
      </div>
      <ul>
        <li>
          <button
            type="button"
            onClick={() => onSelect(null)}
            aria-current={selectedSlug === null ? "true" : undefined}
            className={`w-full text-left px-4 py-2.5 flex items-center justify-between border-b border-white/5 border-l-2 ${
              selectedSlug === null
                ? "bg-white/[0.07] border-l-healthy-ink"
                : "border-l-transparent hover:bg-white/[0.04]"
            }`}
          >
            <span className="flex flex-col">
              <span className="text-sm">All branches</span>
              <span className="text-[11px] text-gray-500">Fleet-wide view</span>
            </span>
          </button>
        </li>
        {branches.map((b) => (
          <li key={b.siteId}>
            <button
              type="button"
              onClick={() => onSelect(b.slug)}
              aria-current={selectedSlug === b.slug ? "true" : undefined}
              className={`w-full text-left px-4 py-2.5 flex items-center justify-between border-b border-white/5 border-l-2 ${
                selectedSlug === b.slug
                  ? "bg-white/[0.07] border-l-healthy-ink"
                  : "border-l-transparent hover:bg-white/[0.04]"
              }`}
            >
              <span className="flex flex-col min-w-0 pr-2">
                <span className="text-sm truncate">{b.name}</span>
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
