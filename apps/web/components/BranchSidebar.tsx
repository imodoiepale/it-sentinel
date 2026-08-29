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
    <nav className="w-72 shrink-0 border-r border-line bg-panel overflow-y-auto">
      <div className="p-4 border-b border-line">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted">Sentinel Global</div>
        {/*
          A branch roster of zero is a legitimate state, not a rendering
          failure — this is the panel that has already been read as "the page
          is broken". It says which nothing it is rather than printing
          "0 branches · 0 reporting" and leaving the operator to guess.
        */}
        {total === 0 ? (
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            No branches yet. Enrolled sites appear here as soon as one reports.
          </p>
        ) : (
          <>
            <div className="text-sm mt-1 text-ink">
              {total} branch{total === 1 ? "" : "es"} · {online} reporting
            </div>
            <p className="mt-0.5 text-[11px] text-muted">
              {machineCount === 0
                ? "no machines reporting yet"
                : `${machineCount} machine${machineCount === 1 ? "" : "s"}`}
            </p>
            {/*
              Only rendered when there is something wrong. A permanent
              "Critical 0 · Warning 0" trains the eye to skip the exact line
              that has to be noticed the one time it is not zero.
            */}
            {(critical > 0 || warning > 0) && (
              <div className="flex flex-wrap gap-2 mt-3 text-[11px]">
                {critical > 0 && (
                  <span className="rounded border border-critical/40 bg-critical/10 px-1.5 py-0.5 font-medium text-critical-ink">
                    {critical} critical
                  </span>
                )}
                {warning > 0 && (
                  <span className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-medium text-warning-ink">
                    {warning} warning
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <ul>
        <li>
          <button
            type="button"
            onClick={() => onSelect(null)}
            aria-current={selectedSlug === null ? "true" : undefined}
            className={`w-full text-left px-4 py-2.5 flex items-center justify-between border-b border-line-soft border-l-2 ${
              selectedSlug === null
                ? "bg-surface-2 border-l-healthy font-medium text-ink"
                : "border-l-transparent text-ink-soft hover:bg-surface hover:text-ink"
            }`}
          >
            <span className="flex flex-col">
              <span className="text-sm">All branches</span>
              <span className="text-[11px] text-muted">Fleet-wide view</span>
            </span>
          </button>
        </li>
        {branches.map((b) => (
          <li key={b.siteId}>
            <button
              type="button"
              onClick={() => onSelect(b.slug)}
              aria-current={selectedSlug === b.slug ? "true" : undefined}
              className={`w-full text-left px-4 py-2.5 flex items-center justify-between border-b border-line-soft border-l-2 ${
                selectedSlug === b.slug
                  ? "bg-surface-2 border-l-healthy font-medium text-ink"
                  : "border-l-transparent text-ink-soft hover:bg-surface hover:text-ink"
              }`}
            >
              <span className="flex flex-col min-w-0 pr-2">
                <span className="text-sm truncate">{b.name}</span>
                <span className="text-[11px] text-muted">
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
