"use client";

import { useCallback, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";

/**
 * The ElevenLabs Conversational AI agent that actually holds the 13 webhook
 * tools. Until now it existed only in the ElevenLabs dashboard and had no
 * surface in this console at all, which is why "where do I talk?" was a fair
 * question to ask of a product whose whole pitch is voice.
 *
 * The official `@elevenlabs/react` SDK is used rather than the drop-in
 * `<elevenlabs-convai>` embed script. The embed renders ElevenLabs' own
 * floating orb, which is a black box: it cannot tell this console whether the
 * socket is connecting, whether the mic was refused, or whether the agent is
 * mid-sentence. Every one of those needs to be visible here, because a
 * control that goes quiet and explains nothing is the exact defect being
 * fixed. The SDK exposes `status` and `isSpeaking` directly, so the states
 * below are read from the live connection instead of being mimed.
 */

/**
 * Set `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` to point the console at a different
 * agent. The fallback is the configured production agent, so a deploy that
 * forgets the variable still talks to something real rather than failing at
 * the first click with an empty id.
 */
const AGENT_ID =
  process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID ?? "agent_8001m15d76mafg9rgjkpyfxwm1z6";

/** What the operator is shown. Derived from the SDK's connection state, never guessed. */
type Phase = "idle" | "connecting" | "listening" | "speaking" | "failed";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Talk to Sentinel",
  connecting: "Connecting…",
  listening: "Listening — speak now",
  speaking: "Sentinel is speaking",
  failed: "Voice unavailable",
};

/**
 * Status is carried by the words first. The dot only reinforces it, and each
 * phase gets a distinct fill *and* a distinct label, so nothing here depends
 * on the operator being able to tell teal from amber — same rule StatusDot
 * follows for fleet health.
 */
const PHASE_DOT: Record<Phase, string> = {
  idle: "bg-unknown",
  connecting: "bg-warning animate-pulse",
  listening: "bg-healthy animate-pulse",
  speaking: "bg-[#2dd4bf]",
  failed: "bg-critical",
};

/**
 * Turns a getUserMedia rejection into something an operator can act on. The
 * raw DOMException names ("NotAllowedError") tell a user nothing about the
 * padlock icon they need to click.
 */
function describeMicFailure(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone blocked. Allow mic access for this site (padlock icon in the address bar), then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone found. Plug one in or pick an input device, then try again.";
  }
  if (name === "NotReadableError") {
    return "The microphone is in use by another app. Close it and try again.";
  }
  return `Couldn't open the microphone: ${err instanceof Error ? err.message : String(err)}`;
}

function VoiceAgentPanel() {
  // Distinct from the SDK's own error state: this covers everything that goes
  // wrong *before* a session exists (no mic, no permission, insecure origin),
  // which the SDK never sees because it is never reached.
  const [localFailure, setLocalFailure] = useState<string | null>(null);
  // Bridges the gap between the click and the SDK reporting "connecting",
  // so the button is never visually inert while permission is being granted.
  const [handshaking, setHandshaking] = useState(false);

  const { status, message, isSpeaking, startSession, endSession } = useConversation({
    onConnect: () => {
      setHandshaking(false);
      setLocalFailure(null);
    },
    onDisconnect: () => setHandshaking(false),
    onError: (err: string) => {
      setHandshaking(false);
      setLocalFailure(err || "The voice connection dropped.");
    },
  });

  const failure = localFailure ?? (status === "error" ? message ?? "The voice connection failed." : null);

  const phase: Phase = failure
    ? "failed"
    : status === "connected"
      ? isSpeaking
        ? "speaking"
        : "listening"
      : status === "connecting" || handshaking
        ? "connecting"
        : "idle";

  const live = status === "connected" || status === "connecting" || handshaking;

  const begin = useCallback(async () => {
    setLocalFailure(null);

    // Voice needs a secure context. Saying so beats letting getUserMedia throw
    // an opaque error on an http origin.
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setLocalFailure("Voice needs a secure (https) connection and a browser with microphone support.");
      return;
    }

    setHandshaking(true);

    // The mic is requested here, on an explicit click, rather than being left
    // to the SDK — two reasons. A refusal surfaces as our own message instead
    // of vanishing inside the library, and nothing touches the microphone on
    // page load, which browsers block and operators resent.
    let probe: MediaStream;
    try {
      probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setHandshaking(false);
      setLocalFailure(describeMicFailure(err));
      return;
    }
    // Released immediately; the SDK opens its own stream and the permission
    // it just granted means that second request raises no new prompt.
    probe.getTracks().forEach((track) => track.stop());

    startSession({ agentId: AGENT_ID, connectionType: "webrtc" });
  }, [startSession]);

  const end = useCallback(() => {
    setHandshaking(false);
    endSession();
  }, [endSession]);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => (live ? end() : void begin())}
        aria-pressed={live}
        className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${
          live
            ? "border-[#2dd4bf]/60 bg-[#2dd4bf]/15 text-[#5eead4]"
            : "border-[#2dd4bf]/40 bg-[#2dd4bf]/10 text-[#5eead4] hover:bg-[#2dd4bf]/20"
        }`}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${PHASE_DOT[phase]}`} aria-hidden />
        <span aria-hidden>🎧</span>
        <span>{live ? "End call" : "Talk to Sentinel"}</span>
        <span className="sr-only">
          {live
            ? "End the voice conversation with the Sentinel agent"
            : "Start a voice conversation with the Sentinel agent. Uses your microphone."}
        </span>
      </button>

      {/*
        The status line is always rendered once a call is live so the control
        can never look the same when it is working as when it is broken. It is
        polite rather than assertive: phase changes narrate between the agent's
        own turns instead of cutting across them.
      */}
      {(live || phase === "failed") && (
        <span
          role="status"
          aria-live="polite"
          className={`text-xs ${phase === "failed" ? "text-critical" : "text-gray-400"}`}
        >
          {failure ?? PHASE_LABEL[phase]}
        </span>
      )}
    </div>
  );
}

/**
 * `useConversation` must sit under a `ConversationProvider`, so the provider
 * is kept here and the panel stays a plain child of it.
 */
export function VoiceAgentWidget() {
  return (
    <ConversationProvider>
      <VoiceAgentPanel />
    </ConversationProvider>
  );
}
