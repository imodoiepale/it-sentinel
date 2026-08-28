import { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./supabase";

/**
 * The one Realtime subscription in the app, exactly matching the tables in
 * the publication: asset_health, alerts, incidents, sessions
 * (packages/db/migrations/0009_realtime.sql) and console_directives
 * (0026_console_directives.sql). Every screen that needs live data
 * subscribes through this single channel rather than opening its own —
 * cheaper on the Realtime connection budget and keeps the "never silently
 * stays green" staleness guarantee visible in one place.
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

export function subscribeToFleetUpdates(handlers: RealtimeHandlers): RealtimeChannel {
  const channel = supabase
    .channel("fleet-updates")
    .on("postgres_changes", { event: "*", schema: "public", table: "asset_health" }, (payload) => {
      handlers.onAssetHealthChange?.(payload.new as Record<string, unknown>);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "alerts" }, (payload) => {
      handlers.onAlertChange?.(payload.new as Record<string, unknown>);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "incidents" }, (payload) => {
      handlers.onIncidentChange?.(payload.new as Record<string, unknown>);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, (payload) => {
      handlers.onSessionChange?.(payload.new as Record<string, unknown>);
    })
    // INSERT only: a directive is updated once, to mark it consumed, and
    // that update is bookkeeping rather than something that happened.
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "console_directives" }, (payload) => {
      handlers.onConsoleDirective?.(payload.new as Record<string, unknown>);
    })
    .subscribe();

  return channel;
}

export function unsubscribe(channel: RealtimeChannel) {
  supabase.removeChannel(channel);
}
