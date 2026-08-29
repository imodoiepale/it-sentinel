"use client";

import { useEffect, useState } from "react";
import { ui } from "../../lib/theme";
import { fetchSites, type PublicSite } from "./sites";

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
      <div className={`mt-8 ${ui.card}`}>
        <p className={ui.muted}>{retrying ? "Reaching the control plane…" : "Roster unreachable."}</p>
      </div>
    );
  }

  return (
    <ul className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {sites.map((site) => (
        <li key={site.id} className="rounded-[36px] border border-cloud bg-snow px-5 py-4">
          <p className="text-[15px] font-medium text-obsidian">{site.name}</p>
          <p className={`mt-1 ${ui.caption}`}>{site.region}</p>
        </li>
      ))}
    </ul>
  );
}
