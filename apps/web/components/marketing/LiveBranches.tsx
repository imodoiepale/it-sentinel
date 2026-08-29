"use client";

import { useEffect, useState } from "react";
import { LivePip } from "./primitives";
import { fetchSites, type PublicSite } from "./sites";

const CRITICALITY_STYLE: Record<string, string> = {
  critical: "border-warning/40 text-warning",
  standard: "border-white/15 text-gray-400",
};

/**
 * Rendered from a server fetch when the control plane answered during SSR,
 * and self-heals in the browser when it did not. The service sleeps on
 * Render's free tier, so a cold first request can outrun any sensible SSR
 * budget; retrying client-side keeps the page's paint fast without giving
 * up the live data. There is no third state that spins forever — the retry
 * has its own deadline, after which the section says so plainly.
 */
export function LiveBranches({ initial }: { initial: PublicSite[] | null }) {
  const [sites, setSites] = useState<PublicSite[] | null>(initial);
  const [retrying, setRetrying] = useState(initial === null);

  useEffect(() => {
    if (initial !== null) return;
    let live = true;
    fetchSites(12_000).then((result) => {
      if (!live) return;
      setSites(result);
      setRetrying(false);
    });
    return () => {
      live = false;
    };
  }, [initial]);

  if (!sites) {
    return (
      <div className="mt-10 rounded-xl border border-white/[0.09] bg-white/[0.02] p-6">
        <p className="text-sm text-gray-400">
          {retrying
            ? "Reaching the control plane for the live branch roster…"
            : "The live branch roster isn’t reachable from here right now. The console has the full picture."}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="mt-10 flex items-baseline justify-between gap-4">
        <LivePip label="Live from the control plane" />
        <p className="text-xs text-muted">
          {sites.length} {sites.length === 1 ? "branch" : "branches"} enrolled
        </p>
      </div>
      {/*
        Separately bordered cards rather than a hairline-gap grid: the branch
        count is whatever the fleet happens to be, and any count that does not
        divide by four leaves the grid's own fill showing through the empty
        cells as a phantom tile. Independent cards simply stop.
      */}
      <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {sites.map((site) => (
          <li key={site.id} className="rounded-xl border border-white/[0.09] bg-white/[0.02] p-5">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-semibold text-white">{site.name}</p>
              <span
                className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                  CRITICALITY_STYLE[site.criticality] ?? CRITICALITY_STYLE.standard
                }`}
              >
                {site.criticality}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">{site.region}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
