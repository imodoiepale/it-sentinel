"use client";

import { useCallback, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { AskSentinel } from "./AskSentinel";

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
 * Push-to-talk voice: "open Junction Mall", "open Sarit". Grammar is
 * deliberately narrow at this stage — only branch-opening is wired end to
 * end. Anything beyond that (fix the spooler on X, check Enquest
 * everywhere) resolves through the same command dispatch path as the
 * console UI, and per the plan, any T3+ action is READ BACK AND CONFIRMED
 * before it runs — never fired directly off a voice transcript.
 *
 * Question-asking lives in the AskSentinel panel this bar toggles rather
 * than in the push-to-talk grammar. Keeping the two apart means the
 * branch-opening path stays the narrow, unambiguous thing it was built to
 * be — every transcript here still resolves against the branch list only —
 * while free-form questions get an input an operator can proofread before
 * anything is sent.
 */
export function VoiceBar({ onOpenBranch }: Props) {
  const [state, setState] = useState<VoiceState>("idle");
  const [transcript, setTranscript] = useState("");
  const [candidates, setCandidates] = useState<ResolvedBranch[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);
  const [askOpen, setAskOpen] = useState(false);

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
    const SpeechRecognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setErrorMessage("Speech recognition isn't supported in this browser.");
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
    recognition.onerror = () => {
      setErrorMessage("Didn't catch that — try again.");
      setState("error");
    };
    recognition.onend = () => {
      setState((s) => (s === "listening" ? "idle" : s));
    };

    recognitionRef.current = recognition;
    setState("listening");
    setErrorMessage(null);
    recognition.start();
  }, [resolveBranch]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  return (
    <div className="relative flex items-center gap-3">
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
        <span className="text-xs text-critical">{errorMessage}</span>
      )}

      {transcript && state !== "confirming" && (
        <span className="text-xs text-gray-500 italic">&ldquo;{transcript}&rdquo;</span>
      )}

      <button
        onMouseDown={startListening}
        onMouseUp={stopListening}
        onTouchStart={startListening}
        onTouchEnd={stopListening}
        className={`px-3 py-1.5 rounded-full text-sm border ${
          state === "listening"
            ? "bg-critical/20 border-critical text-critical animate-pulse"
            : "bg-white/5 border-white/10 hover:bg-white/10"
        }`}
        title="Hold to talk — try 'open Junction Mall'"
      >
        🎙 {state === "listening" ? "Listening…" : "Open branch"}
      </button>

      <button
        onClick={() => setAskOpen((open) => !open)}
        aria-expanded={askOpen}
        className={`px-3 py-1.5 rounded-full text-sm border ${
          askOpen ? "bg-white/20 border-white/30" : "bg-white/5 border-white/10 hover:bg-white/10"
        }`}
        title="Ask the Sentinel Agent a question about the fleet"
      >
        Ask Sentinel
      </button>

      {askOpen && (
        <div className="absolute right-0 top-full z-30 mt-2">
          <AskSentinel />
        </div>
      )}
    </div>
  );
}
