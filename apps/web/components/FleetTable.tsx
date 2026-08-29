"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import type { FleetRow } from "../lib/types";
import { StatusDot } from "./StatusDot";

interface Props {
  rows: FleetRow[];
  onOpenMachine: (assetId: string) => void;
  /**
   * Optional, and both are optional on purpose: the row controls have to work
   * in the page as it already renders it. Without `branches` the destination
   * list is read from `sites` on first use — RLS-scoped, so it can only ever
   * offer branches this operator already administers — and without
   * `onFleetChanged` the move or retirement still happens, it just isn't
   * followed by a refetch, so the board lags the database until the next
   * reload.
   *
   * One callback covers both actions rather than two: there is a single
   * refetch behind it (useFleet's `reload`), and a second prop pointing at the
   * same function would only invite the two paths to drift apart.
   */
  branches?: { siteId: string; name: string }[];
  onFleetChanged?: () => void;
  /**
   * Distinguishes "the fleet query has not answered" from "the fleet is
   * empty". Both render zero rows, and telling an operator that nothing is
   * broken while the query is still in flight is a lie the board must not
   * tell.
   */
  loading?: boolean;
}

/** What reassign_asset() (migration 0028) returns. */
interface ReassignResult {
  hostname: string;
  to_site_name: string;
  already_there: boolean;
  alerts_moved: number;
}

/** What retire_asset() (migration 0027) returns. */
interface RetireResult {
  asset_id: string;
  hostname: string;
  site_id: string;
  decommissioned_at: string | null;
  already_retired: boolean;
}

function ramClass(usage: number | null) {
  if (usage == null) return "text-muted";
  if (usage >= 93) return "text-critical-ink";
  if (usage >= 85) return "text-warning-ink";
  return "text-ink-soft";
}

function diskClass(freePercent: number | null) {
  if (freePercent == null) return "text-muted";
  if (freePercent < 10) return "text-critical-ink";
  if (freePercent < 15) return "text-warning-ink";
  return "text-ink-soft";
}

/**
 * Branch · PC · Network · Email · Printer · Enquest · Security · RAM ·
 * Disk · VNC · Tickets — exactly the table from the plan, sortable, with
 * "only what's broken" as the default filter so the technician sees
 * problems first, not a wall of green.
 *
 * Branch leads the row rather than trailing it. On "All branches" the
 * hostname alone does not say where the machine is, and the answer was
 * previously off the right-hand edge of a twelve-column table — so the one
 * column that locates the problem was the one you had to scroll to find.
 */
export function FleetTable({ rows, onOpenMachine, branches, onFleetChanged, loading = false }: Props) {
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
  // Retirement needs no destination to pick, so "open" and "asked to confirm"
  // are the same state: the first click swaps the button for a sentence naming
  // the machine, the second click is the act.
  const [retiringId, setRetiringId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [sites, setSites] = useState<{ siteId: string; name: string }[]>(branches ?? []);
  // Where a row was moved to, remembered per asset. Without `onFleetChanged`
  // nothing refetches, and a row that still shows its old branch after the
  // operator moved it is the board lying about the fleet — the one thing this
  // console must never do, even for a few seconds.
  const [movedTo, setMovedTo] = useState<Record<string, string>>({});
  // Retired ids are dropped locally as well as by the refetch. useFleet's
  // reload is a round trip, and for that round trip the board would otherwise
  // still be offering a Retire button for a machine already off the roster.
  const [retiredIds, setRetiredIds] = useState<string[]>([]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (retiredIds.includes(r.assetId)) return false;
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
  }, [rows, onlyProblems, query, movedTo, retiredIds]);

  /**
   * True when every row already says the same branch — i.e. the sidebar has a
   * single branch selected. The column still renders, because a blank cell
   * reads as "no branch" and because the header order is what tells an
   * operator what they are looking at, but it drops to the muted rung so it
   * stops competing with the hostname it now sits in front of.
   */
  const uniformBranch = useMemo(() => {
    if (rows.length < 2) return false;
    return rows.every((r) => r.branchName === rows[0].branchName);
  }, [rows]);

  useEffect(() => {
    if (branches) setSites(branches);
  }, [branches]);

  const openMove = useCallback(
    async (row: FleetRow) => {
      setMovingId(row.assetId);
      setRetiringId(null);
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

  // Only one of the two controls is ever open on a row, and never on two rows
  // at once: `pending` is shared, so a second open control would render its
  // own button as busy while somebody else's call is in flight.
  const openRetire = useCallback((row: FleetRow) => {
    setRetiringId(row.assetId);
    setMovingId(null);
    setConfirming(false);
    setNotice(null);
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
      onFleetChanged?.();
    },
    [destination, sites, closeMove, onFleetChanged],
  );

  const submitRetire = useCallback(
    async (row: FleetRow) => {
      setPending(true);
      setNotice(null);
      // Same shape as the move: straight to the RPC on the operator's own
      // session, so auth.uid() inside retire_asset() resolves to the real
      // person and the audit_log row it writes names them rather than the
      // service role. p_actor_id is deliberately not sent — the function only
      // honours it when there is no JWT, and sending one from here would be
      // asking to be ignored at best.
      const { data, error } = await supabase.rpc("retire_asset", {
        p_asset_id: row.assetId,
        p_reason: "retired from the console",
      });
      setPending(false);

      if (error) {
        // The function's own errcodes, spelled out as situations. 42501 is the
        // site_access role check, which is a fact about this operator at this
        // branch, not a bug they can retry their way past.
        const text =
          error.code === "42501"
            ? `You're not authorised to retire machines at ${row.branchName || "this branch"}. That needs sysadmin, security admin or IT manager rights here.`
            : error.code === "P0002"
              ? `${row.hostname} is no longer in the database. The board is out of date — reload it.`
              : error.message;
        setNotice({ tone: "error", text });
        return;
      }

      const result = (Array.isArray(data) ? data[0] : data) as RetireResult | null;
      setRetiringId(null);
      setRetiredIds((ids) => (ids.includes(row.assetId) ? ids : [...ids, row.assetId]));
      // already_retired is not a failure and not a success either — the
      // function is idempotent, so a double click gets here with nothing
      // having happened the second time. Saying "retired" would credit this
      // operator with somebody else's action.
      setNotice({
        tone: "ok",
        text: result?.already_retired
          ? `${result.hostname} was already off the roster. Nothing changed, and the original retirement still stands in the audit log.`
          : `${result?.hostname ?? row.hostname} has been retired. It is off the roster and its history — every command, session and audit entry — is kept. Uninstall the agent on the machine itself to stop it reporting.`,
      });
      onFleetChanged?.();
    },
    [onFleetChanged],
  );

  return (
    <div className="flex-1 overflow-auto min-w-0">
      <div className="sticky top-0 z-10 bg-canvas/95 backdrop-blur-sm flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 border-b border-line">
        <label className="relative min-w-[12rem] flex-1 max-w-sm">
          <span className="sr-only">Search machines</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search hostname or branch…"
            className="w-full rounded-md border border-line bg-surface-2 px-3 py-1.5 text-sm text-ink placeholder:text-muted"
          />
        </label>
        {/*
          Only rendered once there is something to count. "0 of 0 machines"
          beside an empty table is two ways of saying nothing, and it reads as
          a failed query rather than an empty fleet.
        */}
        {rows.length > 0 && (
          <div className="text-xs text-muted tabular-nums" aria-live="polite">
            {visible.length === rows.length
              ? `${rows.length} machine${rows.length === 1 ? "" : "s"}`
              : `${visible.length} of ${rows.length} machines`}
          </div>
        )}
        <label className="ml-auto flex cursor-pointer items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-line-strong hover:text-ink">
          <input
            type="checkbox"
            checked={onlyProblems}
            onChange={(e) => setOnlyProblems(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-line-strong accent-healthy"
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
          // The -ink step, not the fill: the tailwind config says why — a fill
          // colour tuned for a dot does not clear the text floor.
          className={`px-4 py-2.5 text-xs leading-5 border-b ${
            notice.tone === "ok"
              ? "border-healthy/40 bg-healthy/10 text-healthy-ink"
              : "border-critical/40 bg-critical/10 text-critical-ink"
          }`}
        >
          <span className="sr-only">{notice.tone === "ok" ? "Success: " : "Error: "}</span>
          {notice.text}
        </div>
      )}
      <table className="w-full text-sm">
        <thead className="text-left text-muted text-[11px] uppercase tracking-wider">
          <tr className="border-b border-line">
            {/* "#" is a glyph, not a word: aria-hidden on the symbol and a
                real name behind it, so the cell is announced as "Row 3"
                rather than "number sign 3" or "hash 3". */}
            <th className="pl-4 pr-2 py-2.5 font-medium">
              <span aria-hidden>#</span>
              <span className="sr-only">Row</span>
            </th>
            <th className="px-3 py-2.5 font-medium">Branch</th>
            <th className="px-3 py-2.5 font-medium">Machine</th>
            <th className="px-3 py-2.5 font-medium">Health</th>
            <th className="px-3 py-2.5 font-medium">Network</th>
            <th className="px-3 py-2.5 font-medium">Email</th>
            <th className="px-3 py-2.5 font-medium">Printer</th>
            <th className="px-3 py-2.5 font-medium">Enquest</th>
            <th className="px-3 py-2.5 font-medium">Security</th>
            <th className="px-3 py-2.5 font-medium">RAM</th>
            <th className="px-3 py-2.5 font-medium">Disk</th>
            <th className="px-3 py-2.5 font-medium">VNC</th>
            <th className="px-3 py-2.5 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {/*
            Three different nothings, and they must not read alike: the query
            has not answered, this branch has no machines, and the filter or
            the search box excluded them all. Only the last one is the
            operator's own doing, and only that one offers a way back.
          */}
          {rows.length === 0 && (
            <tr>
              <td colSpan={13} className="px-4 py-20">
                <div className="mx-auto max-w-sm text-center">
                  <p className="text-sm font-medium text-ink-soft">
                    {loading ? "Reading the fleet…" : "Nothing is reporting on this branch"}
                  </p>
                  {!loading && (
                    <p className="mt-2 text-sm leading-relaxed text-muted">
                      The board is live — no machine here has checked in. An enrolled agent
                      reports every fifteen seconds and appears on its own.
                    </p>
                  )}
                </div>
              </td>
            </tr>
          )}
          {rows.length > 0 && visible.length === 0 && (
            <tr>
              <td colSpan={13} className="px-4 py-20">
                <div className="mx-auto max-w-sm text-center">
                  <p className="text-sm font-medium text-ink-soft">
                    {onlyProblems
                      ? "Nothing looks broken here"
                      : `No machine matches “${query.trim()}”`}
                  </p>
                  <button
                    type="button"
                    onClick={() => (onlyProblems ? setOnlyProblems(false) : setQuery(""))}
                    className="mt-3 rounded-md border border-line px-3 py-1.5 text-xs text-muted transition-colors hover:border-line-strong hover:text-ink"
                  >
                    {onlyProblems ? "Show every machine" : "Clear the search"}
                  </button>
                </div>
              </td>
            </tr>
          )}
          {visible.map((r, i) => (
            <tr
              key={r.assetId}
              className="border-b border-line-soft hover:bg-surface-2 cursor-pointer"
              onClick={() => onOpenMachine(r.assetId)}
            >
              {/* Numbered off the rendered list, not the incoming array: the
                  filter and the search box both remove rows, and a column that
                  counted the source would skip numbers and read as a bug in
                  the board rather than as the filter doing its job. */}
              <td className="pl-4 pr-2 py-2.5 tabular-nums text-xs text-muted">{i + 1}</td>
              <td className="px-3 py-2.5">
                <span
                  className={`block truncate max-w-[10rem] text-xs ${uniformBranch ? "text-muted" : "text-ink-soft"}`}
                  title={movedTo[r.assetId] ?? r.branchName}
                >
                  {movedTo[r.assetId] ? (
                    <>
                      <span className="sr-only">{r.hostname} now belongs to </span>
                      now at {movedTo[r.assetId]}
                    </>
                  ) : (
                    r.branchName || "—"
                  )}
                </span>
              </td>
              <td className="px-3 py-2.5">
                <div className="font-medium text-ink">{r.hostname}</div>
                {r.openTicketCount > 0 && (
                  <div className="text-[11px] text-warning-ink">
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
              {/* stopPropagation on the cell: every click inside these
                  controls would otherwise also open the machine workspace,
                  which slides over the very control being used. The actions
                  stay at the right-hand edge even though the branch label has
                  moved to the front — the move control grows to a select and
                  two buttons when it opens, and a column that widens by that
                  much is one to keep away from the columns being scanned. */}
              <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                {movingId !== r.assetId && retiringId !== r.assetId ? (
                  <span className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openMove(r)}
                      className="text-xs px-2 py-1 rounded-md border border-line-strong text-ink-soft hover:bg-surface-3 shrink-0"
                    >
                      Move
                      <span className="sr-only"> {r.hostname} to a different branch</span>
                    </button>
                    {/*
                      Retire, and it is not a delete — there is no delete. The
                      word is load-bearing: assets is referenced by
                      command_runs, sessions, incidents and telemetry, and the
                      audit trail is the whole security claim, so a button that
                      erased a machine would erase the record of what was run
                      on it. Nothing here removes a row; the flag takes it off
                      the roster and the history stays joinable.
                    */}
                    <button
                      type="button"
                      onClick={() => openRetire(r)}
                      className="text-xs px-2 py-1 rounded-md border border-line-strong text-ink-soft hover:border-critical/60 hover:text-critical-ink shrink-0"
                    >
                      Retire
                      <span className="sr-only"> {r.hostname} from the roster, keeping its history</span>
                    </button>
                  </span>
                ) : retiringId === r.assetId ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] leading-4 text-muted max-w-[14rem]">
                      Comes off the roster. Its history is kept.
                    </span>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => submitRetire(r)}
                      className="text-xs px-2 py-1 rounded border border-critical/60 text-critical-ink hover:bg-critical/10 disabled:opacity-40"
                    >
                      {pending ? "Retiring…" : `Confirm: retire ${r.hostname}`}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => setRetiringId(null)}
                      className="text-xs px-2 py-1 text-ink-soft hover:text-ink"
                    >
                      Cancel
                    </button>
                  </div>
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
                      className="text-xs bg-surface-2 border border-line-strong rounded px-1.5 py-1"
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
                        className="text-xs px-2 py-1 rounded border border-line-strong text-ink-soft hover:bg-surface-3 disabled:opacity-40"
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
                        className="text-xs px-2 py-1 rounded border border-warning/60 text-warning-ink hover:bg-warning/10 disabled:opacity-40"
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
                      className="text-xs px-2 py-1 text-ink-soft hover:text-ink"
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
