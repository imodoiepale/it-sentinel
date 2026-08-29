"use client";

import { useCallback, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { VoiceAgentWidget } from "./VoiceAgentWidget";

interface Props {
  onOpenBranch: (slug: string, name: string) => void;
}

type VoiceState = "idle" | "listening" | "resolving" | "confirming" | "error";

interface ResolvedBranch {
  site_id: string;
  name: string;
  slug: string;
  similarity: number;
}

/**
 * Two voice controls sit here, and they are not duplicates of each other.
 *
 * `VoiceAgentWidget` is the ElevenLabs agent — a real conversation, server
 * side, holding the webhook tools that act on the fleet. It is the thing to
 * reach for to *ask* or *do* anything.
 *
 * This bar's own push-to-talk is narrower and deliberately kept: it runs in
 * the browser on the Web Speech API and drives the console's local branch
 * selection. The ElevenLabs agent cannot do that. It runs on ElevenLabs'
 * servers and has no handle on this page's React state, so no webhook tool
 * can change which branch the operator is looking at. Until an `open_branch`
 * client tool is registered on the agent in the ElevenLabs dashboard, this is
 * the only path from a spoken branch name to the console actually moving.
 *
 * The previous version of this button was the reported "click does nothing"
 * bug: it was push-to-talk wearing a label ("Open branch") that promised a
 * click would open something. A quick click started and immediately stopped
 * recognition, so it truly did nothing. It now says what it wants, shows a
 * pressed state, and answers the keyboard as well as the mouse.
 *
 * The Ask Sentinel text box that used to live here has been removed. It
 * posted to `${NEXT_PUBLIC_SENTINEL_AGENT_URL}/v1/ask`, and that variable is
 * pointed at the control plane in deployment — an origin with no such route.
 * Every submission in production was a 404. The agent that serves /v1/ask
 * (`apps/sentinel-agent`) is not deployed, and the ElevenLabs widget now
 * covers question-asking with tools that actually exist.
 */
export function VoiceBar({ onOpenBranch }: Props) {
  const [state, setState] = useState<VoiceState>("idle");
  const [transcript, setTranscript] = useState("");
  const [candidates, setCandidates] = useState<ResolvedBranch[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);

  const resolveBranch = useCallback(async (query: string) => {
    setState("resolving");
    const openMatch = query.match(/^open\s+(.+)$/i);
    const branchQuery = (openMatch?.[1] ?? query).trim();

    const { data, error } = await supabase.rpc("resolve_branch_by_voice", { p_query: branchQuery, p_limit: 3 });
    if (error) {
      setErrorMessage(error.message);
      setState("error");
      return;
    }

    const results = (data ?? []) as ResolvedBranch[];
    if (results.length === 0) {
      setErrorMessage(`No branch matched "${branchQuery}"`);
      setState("error");
      return;
    }

    // A confident, unambiguous top match opens directly. Anything close
    // between the top two (the Sarit/Nyali/Runda/Westend/Junction sibling
    // pairs this was built to handle) surfaces for confirmation instead of
    // guessing.
    const [top, second] = results;
    if (!second || top.similarity - second.similarity > 0.25) {
      onOpenBranch(top.slug, top.name);
      setState("idle");
      setCandidates([]);
      return;
    }

    setCandidates(results);
    setState("confirming");
  }, [onOpenBranch]);

  const startListening = useCallback(() => {
    // Guard re-entry: a keyboard auto-repeat or a touch that also emits mouse
    // events would otherwise call start() on an already-running recognition,
    // which throws InvalidStateError.
    if (recognitionRef.current) return;

    const SpeechRecognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setErrorMessage("Speech recognition isn't supported in this browser — pick a branch from the sidebar.");
      setState("error");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      const text = event.results[0][0].transcript;
      setTranscript(text);
      resolveBranch(text);
    };
    recognition.onerror = (event: any) => {
      // "no-speech" is the tap-instead-of-hold case. Naming it is what turns
      // a dead-feeling button into an instruction.
      setErrorMessage(
        event?.error === "not-allowed"
          ? "Microphone blocked. Allow mic access for this site, then hold the button again."
          : event?.error === "no-speech"
            ? "Didn't hear anything — hold the button down while you speak."
            : "Didn't catch that — hold the button and try again.",
      );
      setState("error");
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setState((s) => (s === "listening" ? "idle" : s));
    };

    recognitionRef.current = recognition;
    setState("listening");
    setErrorMessage(null);
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setErrorMessage("Couldn't start listening — try again.");
      setState("error");
    }
  }, [resolveBranch]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const listening = state === "listening";

  return (
    <div className="flex items-center gap-3">
      <VoiceAgentWidget />

      <span className="h-5 w-px bg-white/10" aria-hidden />

      {state === "confirming" && candidates.length > 0 && (
        <div className="text-xs bg-white/5 border border-white/10 rounded px-3 py-1.5 flex items-center gap-2">
          <span className="text-gray-400">Did you mean</span>
          {candidates.slice(0, 2).map((c) => (
            <button
              key={c.slug}
              onClick={() => {
                onOpenBranch(c.slug, c.name);
                setState("idle");
                setCandidates([]);
              }}
              className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20"
            >
              {c.name}
            </button>
          ))}
          <button onClick={() => { setState("idle"); setCandidates([]); }} className="text-gray-500">
            cancel
          </button>
        </div>
      )}

      {state === "error" && errorMessage && (
        <span role="status" aria-live="polite" className="text-xs text-critical-ink max-w-[18rem]">
          {errorMessage}
        </span>
      )}

      {transcript && state !== "confirming" && state !== "error" && (
        <span className="text-xs text-gray-500 italic">&ldquo;{transcript}&rdquo;</span>
      )}

      <div className="flex flex-col items-center leading-none">
        <button
          type="button"
          onMouseDown={startListening}
          onMouseUp={stopListening}
          // A drag off the button still has to end the take, or recognition
          // runs on with no pressed state to show for it.
          onMouseLeave={stopListening}
          onTouchStart={startListening}
          onTouchEnd={stopListening}
          // Hold-to-talk has to work without a mouse. Space and Enter are the
          // keys a button already answers to; `repeat` filters the auto-repeat
          // storm that holding a key produces.
          onKeyDown={(e) => {
            if (e.key !== " " && e.key !== "Enter") return;
            e.preventDefault();
            if (e.repeat) return;
            startListening();
          }}
          onKeyUp={(e) => {
            if (e.key !== " " && e.key !== "Enter") return;
            e.preventDefault();
            stopListening();
          }}
          aria-pressed={listening}
          className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors ${
            listening
              ? "bg-critical/20 border-critical text-critical-ink ring-2 ring-critical/40"
              : state === "resolving"
                ? "bg-white/10 border-white/20"
                : "bg-white/5 border-white/10 hover:bg-white/10"
          }`}
        >
          <span aria-hidden>🎙</span>
          <span>
            {listening ? "Listening — release to open" : state === "resolving" ? "Finding branch…" : "Hold to open branch"}
          </span>
          <span className="sr-only">
            Hold this button, or hold Space while it is focused, and say a branch name to open it.
          </span>
        </button>
        {/*
          The hint is permanent rather than a tooltip. A `title` attribute is
          invisible to touch, invisible to keyboard, and appears only after a
          hover delay — none of which help the person who clicked once, saw
          nothing happen, and concluded the feature was broken.
        */}
        <span className="mt-1 text-[10px] text-gray-500" aria-hidden>
          hold &amp; say “Lagos”
        </span>
      </div>
    </div>
  );
}
