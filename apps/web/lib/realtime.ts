import { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./supabase";

/**
 * The one Realtime subscription in the app, exactly matching the four
 * tables in the publication (packages/db/migrations/0009_realtime.sql):
 * asset_health, alerts, incidents, sessions. Every screen that needs live
 * data subscribes through this single channel rather than opening its own
 * — cheaper on the Realtime connection budget and keeps the "never
 * silently stays green" staleness guarantee visible in one place.
 */

export type RealtimeTable = "asset_health" | "alerts" | "incidents" | "sessions";

export interface RealtimeHandlers {
  onAssetHealthChange?: (row: Record<string, unknown>) => void;
  onAlertChange?: (row: Record<string, unknown>) => void;
  onIncidentChange?: (row: Record<string, unknown>) => void;
  onSessionChange?: (row: Record<string, unknown>) => void;
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
    .subscribe();

  return channel;
}

export function unsubscribe(channel: RealtimeChannel) {
  supabase.removeChannel(channel);
}
