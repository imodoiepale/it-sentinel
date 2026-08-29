"use client";

import { useEffect, useRef, useState } from "react";
import type { FleetRow } from "../lib/types";
import { subscribeToFleetUpdates, unsubscribe } from "../lib/realtime";
import { StatusDot } from "./StatusDot";

/**
 * What the fleet is doing right now, as it happens.
 *
 * The console already renders live data — the fleet table repaints itself
 * from the same subscription — but a table that quietly changes one cell
 * looks identical to a static screenshot. This panel exists so that "the
 * database is pinging things live" is something a room can SEE: every alert,
 * every red-to-green transition, every session and every spoken command
 * lands here with a timestamp within a second of happening.
 *
 * Rides the single fleet-updates channel (lib/realtime.ts) rather than
 * opening its own. The one thing it adds to that channel is
 * console_directives, which was already in the publication and already the
 * record of "the voice agent just did something".
 */

/** Long enough to prove liveness, short enough that the list never grows. */
const MAX_EVENTS = 20;

interface ActivityEvent {
  key: string;
  at: number;
  /** Reuses the fleet's semantic colours so severity reads the same everywhere. */
  status: "healthy" | "warning" | "critical" | "stale" | "unknown";
  label: string;
  detail: string;
}

interface Props {
  /**
   * Used for two things: turning an asset_id into a hostname, and seeding
   * the known-status map so the first heartbeat after load is recognised as
   * "no change" rather than as a transition.
   */
  assets: FleetRow[];
}

function severityOf(alertSeverity: string): ActivityEvent["status"] {
  return alertSeverity === "p1" || alertSeverity === "p2" ? "critical" : "warning";
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function ActivityFeed({ assets }: Props) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);

  /**
   * Refs, not state: the Realtime callbacks close over these and must see
   * current values without the subscription being torn down and rebuilt on
   * every event — which would drop the events that arrive mid-rebuild.
   */
  const assetsRef = useRef<FleetRow[]>(assets);
  assetsRef.current = assets;
  const knownStatusRef = useRef<Map<string, string>>(new Map());
  const seenRef = useRef<Set<string>>(new Set());

  // Seed rather than overwrite: a transition this component already observed
  // must not be re-derived from a later useFleet reload of the same row.
  useEffect(() => {
    for (const a of assets) {
      if (!knownStatusRef.current.has(a.assetId)) {
        knownStatusRef.current.set(a.assetId, a.online ? a.status : "offline");
      }
    }
  }, [assets]);

  useEffect(() => {
    // A monotonic suffix, because two events can land in the same
    // millisecond and React keys have to stay unique.
    let seq = 0;
    const push = (e: Omit<ActivityEvent, "key" | "at">) => {
      seq += 1;
      const at = Date.now();
      setEvents((prev) => [{ ...e, key: `${at}-${seq}`, at }, ...prev].slice(0, MAX_EVENTS));
    };

    /** True the first time a given fact is seen, false forever after. */
    const isNew = (id: string) => {
      if (!id || seenRef.current.has(id)) return false;
      seenRef.current.add(id);
      return true;
    };

    const hostnameFor = (assetId: string) =>
      assetsRef.current.find((a) => a.assetId === assetId)?.hostname ?? "a machine";

    const sub = subscribeToFleetUpdates({
      onAssetHealthChange: (row) => {
        const assetId = String(row.asset_id ?? "");
        if (!assetId) return;
        const status = row.online === false ? "offline" : String(row.status ?? "unknown");
        const previous = knownStatusRef.current.get(assetId);
        knownStatusRef.current.set(assetId, status);

        // Transitions only. asset_health is rewritten by every heartbeat on
        // a 60-second cadence, so echoing each write would bury the one line
        // that matters under seven identical "still healthy" rows a minute.
        // A machine whose previous state was never observed is recorded
        // silently: claiming a transition we did not see is worse than
        // missing one.
        if (previous === undefined || previous === status) return;

        const recovered = status === "healthy";
        push({
          status: recovered ? "healthy" : status === "offline" ? "critical" : (status as ActivityEvent["status"]),
          label: recovered ? "Recovered" : "Status changed",
          detail: `${hostnameFor(assetId)} went from ${previous} to ${status}`,
        });
      },

      onAlertChange: (row) => {
        const status = String(row.status ?? "open");
        // Keyed on id AND status: the same alert row is updated in place when
        // it resolves, and both the raise and the clear are worth showing.
        if (!isNew(`alert:${row.id}:${status}`)) return;
        push({
          status: status === "open" ? severityOf(String(row.severity ?? "")) : "healthy",
          label: status === "open" ? "Alert raised" : `Alert ${status}`,
          detail: String(row.title ?? "A fault was detected"),
        });
      },

      onIncidentChange: (row) => {
        const status = String(row.status ?? "open");
        if (!isNew(`incident:${row.id}:${status}`)) return;
        push({
          status: status === "resolved" || status === "closed" ? "healthy" : "warning",
          label: `Incident ${status.replace(/_/g, " ")}`,
          detail: String(row.title ?? "Incident"),
        });
      },

      onSessionChange: (row) => {
        if (!isNew(`session:${row.id}`)) return;
        push({
          status: "unknown",
          label: "Session opened",
          detail: `${String(row.mode ?? "remote")} session on ${hostnameFor(String(row.asset_id ?? ""))}`,
        });
      },

      onConsoleDirective: (row) => {
        if (!isNew(`directive:${row.id}`)) return;
        const kind = String(row.kind ?? "directive");
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        const target =
          typeof payload.hostname === "string"
            ? payload.hostname
            : typeof payload.scope === "string"
              ? payload.scope
              : hostnameFor(String(row.asset_id ?? ""));
        push({
          status: "unknown",
          label: "Voice command",
          detail: `${kind.replace(/_/g, " ")} · ${target}`,
        });
      },
    });

    // Realtime's own join state, not an assumption. A panel that says "live"
    // while the socket is down is worse than one that admits it is not — the
    // whole claim being made here is that the screen reflects the database.
    // The channel is shared across every subscriber now, so read its state
    // off the subscription handle rather than assuming this component owns it.
    const isJoined = () => sub.channel?.state === "joined";
    const poll = setInterval(() => setConnected(isJoined()), 1000);
    setConnected(isJoined());

    return () => {
      clearInterval(poll);
      unsubscribe(sub);
    };
  }, []);

  return (
    <aside className="w-80 shrink-0 border-l border-white/10 bg-[#080b0f] flex flex-col">
      <div className="p-3.5 border-b border-white/10 flex items-center justify-between">
        <div className="text-[11px] font-medium uppercase tracking-wider text-gray-500">Live activity</div>
        <div className="flex items-center gap-1.5" role="status">
          <span
            className={`h-2 w-2 rounded-full ${connected ? "bg-healthy animate-breathe" : "bg-stale"}`}
            aria-hidden
          />
          {/* Never colour alone, per StatusDot: the word carries the state too. */}
          <span className={`text-[11px] ${connected ? "text-healthy-ink" : "text-gray-500"}`}>
            {connected ? "Live" : "Connecting…"}
          </span>
          <span className="sr-only">
            {connected ? "Realtime feed connected" : "Realtime feed not connected"}
          </span>
        </div>
      </div>

      <ol className="flex-1 overflow-y-auto" role="log" aria-live="polite" aria-relevant="additions">
        {events.length === 0 && (
          <li className="p-4 text-xs text-muted leading-relaxed">
            Watching the fleet. Alerts, status changes, sessions and spoken commands appear here the moment they
            happen.
          </li>
        )}
        {events.map((e) => (
          <li key={e.key} className="px-3 py-2 border-b border-white/5 flex items-start gap-2">
            <span className="mt-1">
              <StatusDot status={e.status} label={`${e.label}: ${e.detail}`} />
            </span>
            <span className="flex flex-col min-w-0">
              <span className="text-xs text-gray-300">{e.label}</span>
              <span className="text-[11px] text-gray-500 break-words">{e.detail}</span>
            </span>
            <time className="ml-auto text-[10px] text-gray-600 tabular-nums shrink-0" dateTime={new Date(e.at).toISOString()}>
              {clockTime(e.at)}
            </time>
          </li>
        ))}
      </ol>

      {events.length > 0 && (
        <div className="p-2 border-t border-white/10 text-[10px] text-gray-600">
          Newest first · the last {MAX_EVENTS} events are kept
        </div>
      )}
    </aside>
  );
}
