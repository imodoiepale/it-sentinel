import { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./supabase";

/**
 * The one Realtime subscription in the app, exactly matching the tables in
 * the publication: asset_health, alerts, incidents, sessions
 * (packages/db/migrations/0009_realtime.sql) and console_directives
 * (0026_console_directives.sql).
 *
 * This is a real singleton with a subscriber registry, and it has to be.
 * The previous version built a fresh `.channel("fleet-updates").on(...)
 * .subscribe()` chain on every call, which read like three independent
 * subscriptions but was not: supabase-js returns the SAME channel object for
 * a given topic, so the second caller attached handlers to a channel that
 * had already been subscribed and the client threw
 *
 *     cannot add `postgres_changes` callbacks for realtime:fleet-updates
 *     after `subscribe()`
 *
 * — an uncaught exception during render, so the console showed Next.js's
 * "Application error: a client-side exception has occurred" and nothing else.
 * With one subscriber it never fired; it became deterministic the moment a
 * third component (ActivityFeed) mounted alongside useFleet and
 * AlertAnnouncer.
 *
 * So: the channel is created and subscribed exactly once, handlers are
 * fanned out to every registered subscriber, and it is torn down when the
 * last one leaves.
 */

export type RealtimeTable = "asset_health" | "alerts" | "incidents" | "sessions" | "console_directives";

export interface RealtimeHandlers {
  onAssetHealthChange?: (row: Record<string, unknown>) => void;
  onAlertChange?: (row: Record<string, unknown>) => void;
  onIncidentChange?: (row: Record<string, unknown>) => void;
  onSessionChange?: (row: Record<string, unknown>) => void;
  /**
   * Voice-issued directives, as the visible trace of a spoken command.
   *
   * useVoiceDirectives listens to the same table on its own channel because
   * it must ACT on a directive — consuming it, opening a window — which is
   * a different concern to displaying that one arrived. Two listeners on
   * one publication row is fine; a second copy of the acting logic would
   * not be.
   */
  onConsoleDirective?: (row: Record<string, unknown>) => void;
}

/** What a caller holds so it can detach, and read the live connection state. */
export interface FleetSubscription {
  readonly channel: RealtimeChannel | null;
  /** The exact handlers object this subscription registered, for removal. */
  readonly handlers: RealtimeHandlers;
}

const subscribers = new Set<RealtimeHandlers>();
let sharedChannel: RealtimeChannel | null = null;

/** Fan one event out to every subscriber, isolating a thrown handler. */
function emit(pick: (h: RealtimeHandlers) => ((row: Record<string, unknown>) => void) | undefined, row: unknown) {
  for (const handlers of subscribers) {
    try {
      pick(handlers)?.(row as Record<string, unknown>);
    } catch (err) {
      // One component's render bug must not stop the others from updating,
      // and must not kill the channel for the whole page.
      console.error("[realtime] subscriber threw while handling an event:", err);
    }
  }
}

function ensureChannel(): RealtimeChannel {
  if (sharedChannel) return sharedChannel;

  sharedChannel = supabase
    .channel("fleet-updates")
    .on("postgres_changes", { event: "*", schema: "public", table: "asset_health" }, (p) =>
      emit((h) => h.onAssetHealthChange, p.new),
    )
    .on("postgres_changes", { event: "*", schema: "public", table: "alerts" }, (p) => emit((h) => h.onAlertChange, p.new))
    .on("postgres_changes", { event: "*", schema: "public", table: "incidents" }, (p) =>
      emit((h) => h.onIncidentChange, p.new),
    )
    .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, (p) =>
      emit((h) => h.onSessionChange, p.new),
    )
    // INSERT only: a directive is updated once, to mark it consumed, and
    // that update is bookkeeping rather than something that happened.
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "console_directives" }, (p) =>
      emit((h) => h.onConsoleDirective, p.new),
    )
    .subscribe();

  return sharedChannel;
}

export function subscribeToFleetUpdates(handlers: RealtimeHandlers): FleetSubscription {
  subscribers.add(handlers);
  return { channel: ensureChannel(), handlers };
}

export function unsubscribe(subscription: FleetSubscription) {
  subscribers.delete(subscription.handlers);

  // Tear the channel down only when nobody is left. Removing it while
  // another component is still mounted would silently stop that component
  // updating, which looks exactly like "realtime is broken".
  if (subscribers.size === 0 && sharedChannel) {
    void supabase.removeChannel(sharedChannel);
    sharedChannel = null;
  }
}
