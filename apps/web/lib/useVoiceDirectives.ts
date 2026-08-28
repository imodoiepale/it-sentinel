"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";

/**
 * Bridges spoken commands to the operator's screen.
 *
 * The voice agent cannot reach into this browser, so /v1/voice/open writes a
 * row to console_directives (migration 0026) and this hook — listening on
 * Supabase Realtime — acts on it locally. Two consequences worth keeping:
 * the VNC session is still requested by THIS browser under the logged-in
 * operator's own JWT, so audit_log records the human rather than a synthetic
 * voice principal; and no session token ever travels through the voice
 * provider's infrastructure.
 *
 * Directives are marked consumed after handling so a refresh doesn't replay
 * the last command, and only unconsumed ones are picked up on mount.
 */

export interface VoiceDirective {
  id: string;
  kind: "open_machine" | "open_cameras" | "focus_branch" | "announce";
  site_id: string | null;
  asset_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface DirectiveHandlers {
  onOpenMachine?: (assetId: string, mode: "view" | "control") => void;
  onOpenCameras?: (siteId: string | null, scope: string) => void;
  onFocusBranch?: (siteId: string) => void;
  onAnnounce?: (text: string) => void;
}

export function useVoiceDirectives(handlers: DirectiveHandlers, enabled = true) {
  const [lastDirective, setLastDirective] = useState<VoiceDirective | null>(null);

  // Handlers are captured in a ref so the realtime subscription is set up
  // once, not torn down and rebuilt on every parent render.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    async function apply(d: VoiceDirective) {
      if (cancelled) return;
      setLastDirective(d);

      const h = handlersRef.current;
      switch (d.kind) {
        case "open_machine":
          if (d.asset_id) h.onOpenMachine?.(d.asset_id, d.payload.mode === "view" ? "view" : "control");
          break;
        case "open_cameras":
          h.onOpenCameras?.(d.site_id, String(d.payload.scope ?? "all branches"));
          break;
        case "focus_branch":
          if (d.site_id) h.onFocusBranch?.(d.site_id);
          break;
        case "announce":
          h.onAnnounce?.(String(d.payload.text ?? ""));
          break;
      }

      // Best-effort: a failure here means at worst a directive replays on
      // the next mount, which is preferable to dropping it silently.
      await supabase.from("console_directives").update({ consumed: true }).eq("id", d.id);
    }

    // Catch up on anything issued while this screen was closed. Bounded to
    // the last few so a long-idle console doesn't suddenly open ten windows.
    void (async () => {
      const { data } = await supabase
        .from("console_directives")
        .select("id, kind, site_id, asset_id, payload, created_at")
        .eq("consumed", false)
        .order("created_at", { ascending: false })
        .limit(1);
      for (const d of (data ?? []) as VoiceDirective[]) await apply(d);
    })();

    const channel = supabase
      .channel("console-directives")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "console_directives" },
        (payload) => void apply(payload.new as VoiceDirective),
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [enabled]);

  return { lastDirective };
}
