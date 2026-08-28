"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useFleet } from "../lib/useFleet";
import { useAuth } from "../lib/useAuth";
import { BranchSidebar } from "../components/BranchSidebar";
import { FleetTable } from "../components/FleetTable";
import { StatusDot } from "../components/StatusDot";
import { VoiceBar } from "../components/VoiceBar";
import { MachineWorkspace } from "../components/MachineWorkspace";
import { AlertAnnouncer } from "../components/AlertAnnouncer";
import { ActivityFeed } from "../components/ActivityFeed";
import { useVoiceDirectives } from "../lib/useVoiceDirectives";

/**
 * The Command Center screen: branch sidebar, fleet table for the selected
 * branch (or all branches when none is selected), live via useFleet's
 * realtime subscription. Clicking a row or saying "open <branch>" both
 * land on the same MachineWorkspace panel — one seam, two entry points.
 */
export default function CommandCenter() {
  const router = useRouter();
  const { session, loading: authLoading, operatorId, signOut } = useAuth();
  const { branches, loading, error } = useFleet();
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !session) router.push("/login");
  }, [authLoading, session, router]);

  const selectedBranch = useMemo(() => branches.find((b) => b.slug === selectedSlug) ?? null, [branches, selectedSlug]);
  const allRows = useMemo(() => branches.flatMap((b) => b.assets), [branches]);
  const visibleRows = useMemo(
    () => (selectedBranch ? selectedBranch.assets : allRows),
    [selectedBranch, allRows],
  );
  const openAsset = useMemo(
    () => allRows.find((a) => a.assetId === openAssetId) ?? null,
    [allRows, openAssetId],
  );

  /**
   * Spoken commands land here. "Open Lagos" writes a console_directive from
   * the voice webhook; this opens the same MachineWorkspace a click would,
   * so voice and mouse converge on one code path rather than two.
   */
  useVoiceDirectives({
    onOpenMachine: (assetId) => setOpenAssetId(assetId),
    onFocusBranch: (siteId) => {
      const branch = branches.find((b) => b.siteId === siteId);
      if (branch) setSelectedSlug(branch.slug);
    },
    onOpenCameras: (siteId) => {
      const branch = siteId ? branches.find((b) => b.siteId === siteId) : null;
      setSelectedSlug(branch?.slug ?? null);
    },
  });

  if (authLoading || !session) {
    return <div className="min-h-screen flex items-center justify-center bg-[#0b0f14] text-gray-500 text-sm">Loading…</div>;
  }

  if (error) {
    return (
      <div className="p-8 text-critical">
        Failed to load fleet data: {error}
        <div className="text-gray-500 text-sm mt-2">
          Check this operator has a site_access grant — RLS shows nothing at all otherwise, by design.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#0b0f14]">
      <BranchSidebar branches={branches} selectedSlug={selectedSlug} onSelect={setSelectedSlug} />
      <div className="flex-1 flex flex-col">
        <header className="p-4 border-b border-white/10 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">{selectedBranch ? selectedBranch.name : "All Branches"}</h1>
            <p className="text-xs text-gray-500">
              {loading
                ? "Loading…"
                : `${branches.reduce((n, b) => n + b.assets.length, 0)} machines across ${branches.length} branches`}
            </p>
          </div>
          <div className="flex items-center gap-4">
            {selectedBranch && (
              <StatusDot status={selectedBranch.overallStatus} label={`${selectedBranch.name}: ${selectedBranch.overallStatus}`} />
            )}
            <AlertAnnouncer />
            <VoiceBar
              onOpenBranch={(slug) => {
                setSelectedSlug(slug);
              }}
            />
            <button onClick={() => signOut()} className="text-xs text-gray-500 hover:text-white">
              Sign out
            </button>
          </div>
        </header>
        <div className="flex-1 flex min-h-0">
          <FleetTable rows={visibleRows} onOpenMachine={setOpenAssetId} />
          {/*
            Always visible, and deliberately outside the branch filter: the
            feed's job is to prove the whole fleet is being watched right
            now, which a panel that empties when you click one branch does
            not do. It is fed every asset for hostname lookup, not the
            filtered set.
          */}
          <ActivityFeed assets={allRows} />
        </div>
      </div>

      {openAsset && operatorId && (
        <MachineWorkspace
          assetId={openAsset.assetId}
          hostname={openAsset.hostname}
          operatorId={operatorId}
          onClose={() => setOpenAssetId(null)}
        />
      )}
    </div>
  );
}
