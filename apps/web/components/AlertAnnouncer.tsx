"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CONTROL_PLANE_URL } from "../lib/supabase";
import { subscribeToFleetUpdates, unsubscribe } from "../lib/realtime";

/**
 * Speaks new critical alerts aloud as they arrive.
 *
 * Rides the existing fleet-updates Realtime channel rather than opening a
 * second subscription — the alerts table is already in the publication
 * (migration 0009), so a fault raised by ingest.service.ts reaches this
 * component within a second of the heartbeat that detected it.
 *
 * Audio is fetched from the control plane's /v1/voice/speak proxy so the
 * ElevenLabs key stays server-side. If that is unavailable it degrades to
 * the browser's built-in speech synthesis: a robotic voice is a far better
 * failure mode on stage than silence, and silence is indistinguishable from
 * "the alert never fired".
 */

/** Browsers block autoplay until the user has interacted with the page. */
function useAudioUnlock() {
  const [unlocked, setUnlocked] = useState(false);
  useEffect(() => {
    if (unlocked) return;
    const unlock = () => setUnlocked(true);
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [unlocked]);
  return unlocked;
}

export function AlertAnnouncer({ enabled = true }: { enabled?: boolean }) {
  const [spoken, setSpoken] = useState<string[]>([]);
  const [muted, setMuted] = useState(false);
  const audioUnlocked = useAudioUnlock();

  // Alert ids already announced. A ref, not state, because the Realtime
  // callback closes over it and must see current values without
  // re-subscribing on every announcement.
  const seenRef = useRef<Set<string>>(new Set());
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const speak = useCallback(async (text: string) => {
    try {
      const res = await fetch(`${CONTROL_PLANE_URL}/v1/voice/speak`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`tts ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
      await audio.play();
    } catch {
      // Fallback: browser speech synthesis. Not as good, but audible.
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const channel = subscribeToFleetUpdates({
      onAlertChange: (row) => {
        const id = String(row.id ?? "");
        const severity = String(row.severity ?? "");
        const status = String(row.status ?? "open");

        // Only unseen, currently-open, high-severity alerts. Without the
        // seen-set an UPDATE to an existing alert re-announces it, which on
        // a flapping fault means the agent talks over itself continuously.
        if (!id || seenRef.current.has(id)) return;
        if (status !== "open") return;
        if (severity !== "p1" && severity !== "p2") return;

        seenRef.current.add(id);
        const title = String(row.title ?? "A fault was detected");
        setSpoken((prev) => [title, ...prev].slice(0, 5));
        if (!mutedRef.current) void speak(`Alert. ${title}.`);
      },
    });

    return () => unsubscribe(channel);
  }, [enabled, speak]);

  return (
    <div className="flex items-center gap-2 text-xs">
      <button
        type="button"
        onClick={() => setMuted((m) => !m)}
        className="px-2 py-1 rounded border border-white/10 text-gray-400 hover:text-gray-200"
        aria-pressed={muted}
        title={muted ? "Voice alerts muted" : "Voice alerts on"}
      >
        {muted ? "🔇 Alerts muted" : "🔊 Voice alerts"}
      </button>

      {!audioUnlocked && !muted && (
        // Without this the first alert is silently swallowed by autoplay
        // policy and looks like a broken feature.
        <span className="text-gray-500" role="status">
          click anywhere to enable audio
        </span>
      )}

      {spoken[0] && (
        <span className="text-critical truncate max-w-[22rem]" role="status" aria-live="polite">
          {spoken[0]}
        </span>
      )}
    </div>
  );
}
