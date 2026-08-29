"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ThemeToggle } from "../../components/ThemeToggle";
import { ButtonLink } from "../../components/ui/Button";
import { useFleet } from "../../lib/useFleet";
import { useAuth } from "../../lib/useAuth";
import { BranchSidebar } from "../../components/BranchSidebar";
import { FleetTable } from "../../components/FleetTable";
import { StatusDot } from "../../components/StatusDot";
import { VoiceBar } from "../../components/VoiceBar";
import { MachineWorkspace } from "../../components/MachineWorkspace";
import { AlertAnnouncer } from "../../components/AlertAnnouncer";
import { ActivityFeed } from "../../components/ActivityFeed";
import { useVoiceDirectives } from "../../lib/useVoiceDirectives";

/**
 * The Command Center screen: branch sidebar, fleet table for the selected
 * branch (or all branches when none is selected), live via useFleet's
 * realtime subscription. Clicking a row or saying "open <branch>" both
 * land on the same MachineWorkspace panel — one seam, two entry points.
 */
export default function CommandCenter() {
  const router = useRouter();
  const { session, loading: authLoading, operatorId, signOut } = useAuth();
  const { branches, loading, error, reload } = useFleet();
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

  const machineCount = useMemo(
    () => branches.reduce((n, b) => n + b.assets.length, 0),
    [branches],
  );

  if (authLoading || !session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-canvas text-muted text-sm">
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-canvas flex items-start justify-center p-8">
        <div
          role="alert"
          className="mt-16 max-w-lg rounded-xl border border-critical/40 bg-critical/5 p-6"
        >
          <h1 className="text-base font-semibold text-critical-ink">
            <span className="sr-only">Error: </span>The fleet did not load
          </h1>
          <p className="mt-2 text-sm text-ink-soft break-words">{error}</p>
          <p className="mt-3 text-sm text-muted leading-relaxed">
            Check this operator has a site_access grant — RLS shows nothing at all otherwise, by
            design.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-canvas">
      <BranchSidebar branches={branches} selectedSlug={selectedSlug} onSelect={setSelectedSlug} />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="px-5 py-3.5 border-b border-line flex items-center justify-between gap-4 bg-panel">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight truncate">
              {selectedBranch ? selectedBranch.name : "All branches"}
            </h1>
            <p className="text-xs text-muted mt-0.5">{fleetSummary(loading, branches.length, machineCount)}</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {selectedBranch && (
              <StatusDot status={selectedBranch.overallStatus} label={`${selectedBranch.name}: ${selectedBranch.overallStatus}`} />
            )}
            <AlertAnnouncer />
            <VoiceBar
              onOpenBranch={(slug) => {
                setSelectedSlug(slug);
              }}
            />
            <ThemeToggle />
            <button
              type="button"
              onClick={() => signOut()}
              className="rounded-md border border-line px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-line-strong hover:text-ink"
            >
              Sign out
            </button>
          </div>
        </header>
        <div className="flex-1 flex min-h-0">
          {/*
            `onFleetChanged` is not optional in practice. useFleet's realtime
            channel watches asset_health, alerts, incidents, sessions and
            console_directives — not `assets` — so the two row actions that
            write to `assets` emit nothing the board listens for: a move
            changes site_id and the row keeps rendering under its old branch,
            and a retirement sets decommissioned_at, which is exactly what
            useFleet's roster query filters on, so only a refetch takes the
            row off the board. Passing `branches` on top of that saves
            FleetTable the redundant `sites` query it falls back to.
          */}
          {!loading && branches.length === 0 ? (
            <NothingReporting />
          ) : (
            <FleetTable
              rows={visibleRows}
              onOpenMachine={setOpenAssetId}
              branches={branches}
              onFleetChanged={reload}
              loading={loading}
            />
          )}
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

/**
 * The header line under the branch name.
 *
 * "0 machines across 0 branches" is technically true and reads as a broken
 * page — it has already been mistaken for one. An empty fleet is a real,
 * expected state on a fresh deployment, and the wording has to say which of
 * the two it is: still loading, nothing enrolled, or branches enrolled whose
 * agents have never checked in. Those are three different problems with three
 * different fixes.
 */
function fleetSummary(loading: boolean, branchCount: number, machineCount: number): string {
  if (loading) return "Reading the fleet…";
  if (branchCount === 0) return "No branches enrolled yet";
  const branchLabel = `${branchCount} branch${branchCount === 1 ? "" : "es"}`;
  if (machineCount === 0) return `${branchLabel} · no machines reporting yet`;
  return `${machineCount} machine${machineCount === 1 ? "" : "s"} across ${branchLabel}`;
}

/**
 * Shown instead of an empty table when the operator can genuinely see nothing.
 *
 * A zero-row table with column headings looks like a query that failed. This
 * says what is true — nothing is reporting — and, just as importantly, names
 * the other reason the board can be empty: RLS scopes this screen to the
 * operator's own site grants, so "no branches" and "no branches *you* can
 * see" are indistinguishable from here and the operator should be told both
 * are possible.
 */
function NothingReporting() {
  return (
    <div className="flex-1 min-w-0 overflow-auto p-8">
      <div className="mx-auto mt-12 max-w-lg rounded-xl border border-dashed border-line-strong bg-surface p-8 text-center">
        <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-surface-2">
          <span className="h-2.5 w-2.5 animate-breathe rounded-full bg-stale" aria-hidden />
        </span>
        <h2 className="mt-4 text-base font-semibold text-ink">Nothing is reporting yet</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          The board is live and listening — no machine has checked in. Agents report every fifteen
          seconds, so the first heartbeat from an enrolled machine will appear here on its own.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          If you expected machines here, this screen only shows branches your account has been
          granted. That is enforced in the database, not in this page.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <ButtonLink href="/enroll" className="ui-button-sm">
            Enroll a machine
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
