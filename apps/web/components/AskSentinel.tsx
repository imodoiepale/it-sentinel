"use client";

import { useCallback, useRef, useState } from "react";
import { supabase, SENTINEL_AGENT_URL } from "../lib/supabase";

type AskState = "idle" | "dictating" | "asking" | "answered" | "error";

/** Mirrors ToolResult in apps/sentinel-agent/src/executor.ts, plus the planner's clarification path. */
interface AskResponse {
  clarify?: string;
  toolName?: string;
  outcome?: "success" | "refused";
  data?: unknown;
  refusalReason?: string;
  error?: string;
}

/**
 * The console's way into the Sentinel Agent's /v1/ask. Typing is the
 * primary input and dictation only fills the box — it never auto-submits.
 * Speech recognition mis-hears hostnames and branch names constantly in a
 * room with people in it, and a question you can see and correct before
 * sending is the difference between one attempt and five.
 *
 * A refusal from the agent is rendered as an ANSWER, not an error: "that
 * branch is outside your scope" is the guard doing its job and is exactly
 * the thing worth showing an operator. Only transport-level failures —
 * agent unreachable, non-2xx, no session — are surfaced as errors.
 */
export function AskSentinel() {
  const [state, setState] = useState<AskState>("idle");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);

  const ask = useCallback(async () => {
    const trimmed = question.trim();
    if (!trimmed) return;

    setState("asking");
    setErrorMessage(null);
    setAnswer(null);

    // Read the token at submit time rather than holding it in state: it
    // may have been refreshed since this panel mounted.
    const { data: sessionData } = await supabase.auth.getSession();
    const operatorJwt = sessionData.session?.access_token;
    if (!operatorJwt) {
      setErrorMessage("No active session — sign in again before asking.");
      setState("error");
      return;
    }

    let response: Response;
    try {
      response = await fetch(`${SENTINEL_AGENT_URL}/v1/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: trimmed, operatorJwt }),
      });
    } catch (err) {
      // Almost always the agent not running, or CORS. Name both, because
      // the browser deliberately hides which one it was.
      setErrorMessage(
        `Couldn't reach the Sentinel Agent at ${SENTINEL_AGENT_URL} — is it running, and is this origin allowed? (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      setState("error");
      return;
    }

    const bodyText = await response.text().catch(() => "");
    if (!response.ok) {
      setErrorMessage(`Sentinel Agent returned ${response.status}: ${bodyText.slice(0, 300) || "(empty body)"}`);
      setState("error");
      return;
    }

    try {
      setAnswer(JSON.parse(bodyText) as AskResponse);
    } catch {
      setErrorMessage(`Sentinel Agent returned a non-JSON body: ${bodyText.slice(0, 300)}`);
      setState("error");
      return;
    }
    setState("answered");
  }, [question]);

  const dictate = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setErrorMessage("Speech recognition isn't supported in this browser — type the question instead.");
      setState("error");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event: any) => setQuestion(event.results[0][0].transcript);
    recognition.onerror = () => {
      setErrorMessage("Didn't catch that — type the question instead.");
      setState("error");
    };
    recognition.onend = () => setState((s) => (s === "dictating" ? "idle" : s));

    recognitionRef.current = recognition;
    setErrorMessage(null);
    setState("dictating");
    recognition.start();
  }, []);

  return (
    <div className="w-[26rem] rounded-lg border border-white/10 bg-[#111] p-3 shadow-xl text-left">
      <div className="flex items-center gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void ask();
          }}
          placeholder="Ask about fleet status, an asset, or open incidents…"
          className="flex-1 rounded bg-white/5 border border-white/10 px-2 py-1.5 text-sm outline-none focus:border-white/30"
        />
        <button
          onMouseDown={dictate}
          onMouseUp={() => recognitionRef.current?.stop()}
          onTouchStart={dictate}
          onTouchEnd={() => recognitionRef.current?.stop()}
          title="Hold to dictate the question — you can edit it before sending"
          className={`rounded px-2 py-1.5 text-sm border ${
            state === "dictating" ? "bg-critical/20 border-critical text-critical animate-pulse" : "bg-white/5 border-white/10 hover:bg-white/10"
          }`}
        >
          🎙
        </button>
        <button
          onClick={() => void ask()}
          disabled={state === "asking" || !question.trim()}
          className="rounded px-3 py-1.5 text-sm border border-white/10 bg-white/10 hover:bg-white/20 disabled:opacity-40"
        >
          {state === "asking" ? "Asking…" : "Ask"}
        </button>
      </div>

      {state === "error" && errorMessage && (
        <p className="mt-2 rounded border border-critical/40 bg-critical/10 px-2 py-1.5 text-xs text-critical">{errorMessage}</p>
      )}

      {answer && (
        <div className="mt-2 text-xs">
          {answer.clarify && <p className="text-gray-300">{answer.clarify}</p>}
          {answer.error && <p className="text-critical">{answer.error}</p>}
          {answer.outcome === "refused" && (
            <p className="text-warning">
              Refused ({answer.toolName}): {answer.refusalReason}
            </p>
          )}
          {answer.outcome === "success" && (
            <>
              <p className="mb-1 text-gray-500">{answer.toolName}</p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-2 text-gray-200">
                {JSON.stringify(answer.data, null, 2)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
