"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import type { FleetRow } from "../lib/types";
import { StatusDot } from "./StatusDot";

interface Props {
  rows: FleetRow[];
  onOpenMachine: (assetId: string) => void;
  /**
   * Optional, and both are optional on purpose: the move control has to work
   * in the page as it already renders it. Without `branches` the destination
   * list is read from `sites` on first use — RLS-scoped, so it can only ever
   * offer branches this operator already administers — and without
   * `onReassigned` the move still happens, it just isn't followed by a
   * refetch, so the row keeps its old branch label until the next reload.
   */
  branches?: { siteId: string; name: string }[];
  onReassigned?: () => void;
}

/** What reassign_asset() (migration 0028) returns. */
interface ReassignResult {
  hostname: string;
  to_site_name: string;
  already_there: boolean;
  alerts_moved: number;
}

function ramClass(usage: number | null) {
  if (usage == null) return "text-muted";
  if (usage >= 93) return "text-critical-ink";
  if (usage >= 85) return "text-warning";
  return "text-gray-200";
}

function diskClass(freePercent: number | null) {
  if (freePercent == null) return "text-muted";
  if (freePercent < 10) return "text-critical-ink";
  if (freePercent < 15) return "text-warning";
  return "text-gray-200";
}

/**
 * Branch · PC · Network · Email · Printer · Enquest · Security · RAM ·
 * Disk · VNC · Tickets — exactly the table from the plan, sortable, with
 * "only what's broken" as the default filter so the technician sees
 * problems first, not a wall of green.
 */
export function FleetTable({ rows, onOpenMachine, branches, onReassigned }: Props) {
  // Defaults to false: with a healthy fleet, filtering to problems renders
  // an empty table, which reads as "the app is broken" rather than
  // "everything is fine" — the wrong first impression for a wall display.
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [query, setQuery] = useState("");

  // Which row's move control is open, which destination is chosen, and
  // whether the operator has been asked to confirm yet. Keyed by assetId
  // rather than held per-row so only one move can be in flight at a time —
  // moving machines is not something to do in parallel by accident.
  const [movingId, setMovingId] = useState<string | null>(null);
  const [destination, setDestination] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [sites, setSites] = useState<{ siteId: string; name: string }[]>(branches ?? []);
  // Where a row was moved to, remembered per asset. Without `onReassigned`
  // nothing refetches, and a row that still shows its old branch after the
  // operator moved it is the board lying about the fleet — the one thing this
  // console must never do, even for a few seconds.
  const [movedTo, setMovedTo] = useState<Record<string, string>>({});

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (onlyProblems) {
        const problem =
          r.status !== "healthy" ||
          !r.online ||
          r.printerStatus === "critical" ||
          r.emailStatus === "critical" ||
          r.endpointSecurityStatus === "critical" ||
          r.enquestStatus === "critical";
        if (!problem) return false;
      }
      if (!needle) return true;
      return (
        r.hostname.toLowerCase().includes(needle) ||
        r.branchName.toLowerCase().includes(needle) ||
        (movedTo[r.assetId] ?? "").toLowerCase().includes(needle)
      );
    });
  }, [rows, onlyProblems, query, movedTo]);

  useEffect(() => {
    if (branches) setSites(branches);
  }, [branches]);

  const openMove = useCallback(
    async (row: FleetRow) => {
      setMovingId(row.assetId);
      setDestination("");
      setConfirming(false);
      setNotice(null);
      if (sites.length > 0) return;
      const { data, error } = await supabase.from("sites").select("id, name").order("name");
      if (error) {
        setNotice({ tone: "error", text: `Could not load the branch list: ${error.message}` });
        return;
      }
      setSites((data ?? []).map((s) => ({ siteId: s.id, name: s.name })));
    },
    [sites.length],
  );

  const closeMove = useCallback(() => {
    setMovingId(null);
    setDestination("");
    setConfirming(false);
  }, []);

  const submitMove = useCallback(
    async (row: FleetRow) => {
      setPending(true);
      setNotice(null);
      // Straight to the RPC as the logged-in operator, so auth.uid() inside
      // reassign_asset() is the real person and the audit row names them.
      // Everything that decides whether this is allowed — the role check at
      // BOTH branches, the hostname collision, the audit row — lives in the
      // function, not here, so this button cannot be more permissive than
      // the voice route that calls the same one.
      const { data, error } = await supabase.rpc("reassign_asset", {
        p_asset_id: row.assetId,
        p_site_id: destination,
        p_reason: "reassigned from the console",
      });
      setPending(false);

      if (error) {
        const to = sites.find((s) => s.siteId === destination)?.name ?? "that branch";
        // The database's own codes, spelled out as situations. A raw
        // "duplicate key value violates unique constraint" names an index and
        // nothing the operator can act on.
        const text =
          error.code === "42501"
            ? `You're not allowed to move machines between ${row.branchName || "this branch"} and ${to}. That needs sysadmin, security admin or IT manager rights at both.`
            : error.code === "23505"
              ? `${to} already has a machine called ${row.hostname}. One of the two has to be retired first.`
              : error.message;
        setNotice({ tone: "error", text });
        return;
      }

      const result = (Array.isArray(data) ? data[0] : data) as ReassignResult | null;
      closeMove();
      if (result?.to_site_name) setMovedTo((m) => ({ ...m, [row.assetId]: result.to_site_name }));
      setNotice({
        tone: "ok",
        text: result?.already_there
          ? `${row.hostname} was already at ${result.to_site_name}.`
          : `${row.hostname} moved to ${result?.to_site_name ?? "the new branch"}${
              result?.alerts_moved ? `, with ${result.alerts_moved} open alert${result.alerts_moved === 1 ? "" : "s"}` : ""
            }. Its agent still reports the old branch until SENTINEL_BRANCH_SLUG is updated on the machine.`,
      });
      onReassigned?.();
    },
    [destination, sites, closeMove, onReassigned],
  );

  return (
    <div className="flex-1 overflow-auto min-w-0">
      <div className="sticky top-0 z-10 bg-[#0b0f14]/95 backdrop-blur-sm flex flex-wrap items-center gap-3 px-4 py-3 border-b border-white/10">
        <label className="relative min-w-[12rem] flex-1 max-w-sm">
          <span className="sr-only">Search machines</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search hostname or branch…"
            className="w-full rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-600"
          />
        </label>
        <div className="text-sm text-muted tabular-nums">
          {visible.length} of {rows.length} machines
        </div>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={onlyProblems}
            onChange={(e) => setOnlyProblems(e.target.checked)}
            className="rounded border-white/20"
          />
          Only what&rsquo;s broken
        </label>
      </div>
      {notice && (
        // role="status" rather than colour alone: the tone word is spoken and
        // rendered, so the outcome reads the same to a screen reader and to
        // anyone who cannot tell the red from the green.
        <div
          role="status"
          aria-live="polite"
          // healthy-ink, not healthy: the tailwind config says why — the fill
          // teal is ~3.1:1 on this background and unreadable as text.
          className={`px-4 py-2 text-xs border-b border-white/10 ${notice.tone === "ok" ? "text-healthy-ink" : "text-critical-ink"}`}
        >
          <span className="sr-only">{notice.tone === "ok" ? "Success: " : "Error: "}</span>
          {notice.text}
        </div>
      )}
      <table className="w-full text-sm">
        <thead className="text-left text-gray-500 text-[11px] uppercase tracking-wider">
          <tr className="border-b border-white/10">
            <th className="px-4 py-2.5 font-medium">Machine</th>
            <th className="px-3 py-2.5 font-medium">Health</th>
            <th className="px-3 py-2.5 font-medium">Network</th>
            <th className="px-3 py-2.5 font-medium">Email</th>
            <th className="px-3 py-2.5 font-medium">Printer</th>
            <th className="px-3 py-2.5 font-medium">Enquest</th>
            <th className="px-3 py-2.5 font-medium">Security</th>
            <th className="px-3 py-2.5 font-medium">RAM</th>
            <th className="px-3 py-2.5 font-medium">Disk</th>
            <th className="px-3 py-2.5 font-medium">VNC</th>
            <th className="px-3 py-2.5 font-medium">Branch</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={11} className="px-4 py-16 text-center text-sm text-muted">
                No machines in this view yet. Enrol an agent, or pick another branch.
              </td>
            </tr>
          )}
          {rows.length > 0 && visible.length === 0 && (
            <tr>
              <td colSpan={11} className="px-4 py-16 text-center text-sm text-muted">
                {onlyProblems
                  ? "Nothing looks broken in this set. Clear the filter to see every machine."
                  : `No machine matches “${query.trim()}”.`}
              </td>
            </tr>
          )}
          {visible.map((r) => (
            <tr
              key={r.assetId}
              className="border-b border-white/5 hover:bg-white/[0.04] cursor-pointer"
              onClick={() => onOpenMachine(r.assetId)}
            >
              <td className="px-4 py-2.5">
                <div className="font-medium text-gray-100">{r.hostname}</div>
                {r.openTicketCount > 0 && (
                  <div className="text-[11px] text-warning">
                    {r.openTicketCount} open ticket{r.openTicketCount === 1 ? "" : "s"}
                  </div>
                )}
              </td>
              <td className="px-3 py-2.5">
                <StatusDot status={r.online ? r.status : "critical"} label={`${r.hostname}: ${r.online ? r.status : "offline"}`} />
              </td>
              <td className="px-3 py-2.5"><StatusDot status={r.online ? "healthy" : "critical"} label={r.online ? "online" : "offline"} /></td>
              <td className="px-3 py-2.5"><StatusDot status={r.emailStatus} /></td>
              <td className="px-3 py-2.5"><StatusDot status={r.printerStatus} /></td>
              <td className="px-3 py-2.5"><StatusDot status={r.enquestStatus} /></td>
              <td className="px-3 py-2.5"><StatusDot status={r.endpointSecurityStatus} /></td>
              <td className={`px-3 py-2.5 tabular-nums ${ramClass(r.ramUsage)}`}>
                {r.ramUsage != null ? `${Math.round(r.ramUsage)}%` : "—"}
              </td>
              <td className={`px-3 py-2.5 tabular-nums ${diskClass(r.diskFreePercent)}`}>
                {r.diskFreePercent != null ? `${Math.round(r.diskFreePercent)}% free` : "—"}
              </td>
              <td className="px-3 py-2.5">
                <StatusDot status={r.tightvncStatus === "running" ? "healthy" : "critical"} label={`VNC ${r.tightvncStatus}`} />
              </td>
              {/* stopPropagation on the cell: every click inside the move
                  control would otherwise also open the machine workspace,
                  which slides over the very control being used. */}
              <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                {movingId !== r.assetId ? (
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-gray-400 truncate max-w-[9rem]" title={movedTo[r.assetId] ?? r.branchName}>
                      {movedTo[r.assetId] ? (
                        <>
                          <span className="sr-only">{r.hostname} now belongs to </span>
                          now at {movedTo[r.assetId]}
                        </>
                      ) : (
                        r.branchName || "—"
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => openMove(r)}
                      className="text-xs px-2 py-1 rounded-md border border-white/15 text-gray-300 hover:bg-white/10 shrink-0"
                    >
                      Move
                      <span className="sr-only"> {r.hostname} to a different branch</span>
                    </button>
                  </span>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor={`move-${r.assetId}`}>
                      New branch for {r.hostname}
                    </label>
                    <select
                      id={`move-${r.assetId}`}
                      value={destination}
                      disabled={pending}
                      onChange={(e) => {
                        setDestination(e.target.value);
                        // Changing the destination un-confirms: the sentence
                        // the operator agreed to no longer says what it said.
                        setConfirming(false);
                      }}
                      className="text-xs bg-black/40 border border-white/15 rounded px-1.5 py-1"
                    >
                      <option value="">Choose a branch…</option>
                      {sites.map((s) => (
                        <option key={s.siteId} value={s.siteId}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    {!confirming ? (
                      <button
                        type="button"
                        disabled={!destination || pending}
                        onClick={() => setConfirming(true)}
                        className="text-xs px-2 py-1 rounded border border-white/15 text-gray-200 hover:bg-white/10 disabled:opacity-40"
                      >
                        Move…
                      </button>
                    ) : (
                      // The confirm step spells out both ends and what
                      // follows the machine. A move is not destructive, but
                      // it takes the machine off one branch's board and its
                      // open alerts with it, and the branch that loses it is
                      // not the one looking at this screen.
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => submitMove(r)}
                        className="text-xs px-2 py-1 rounded border border-warning/60 text-warning hover:bg-warning/10 disabled:opacity-40"
                      >
                        {pending
                          ? "Moving…"
                          : `Confirm: move to ${sites.find((s) => s.siteId === destination)?.name ?? ""}`}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={pending}
                      onClick={closeMove}
                      className="text-xs px-2 py-1 text-gray-400 hover:text-gray-200"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
