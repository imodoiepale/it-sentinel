"use client";

import { useState } from "react";
import { CONTROL_PLANE_URL } from "../lib/supabase";

interface Props {
  assetId: string;
  operatorId: string;
}

interface LogEntry {
  command: string;
  tier: "T2" | "T3";
  status: "pending" | "refused" | "dispatched";
  detail?: string;
}

/**
 * Elevated PowerShell against the already-elevated agent (LocalSystem —
 * see the plan's "Elevated execution model"). This UI does not execute
 * anything itself; it only dispatches a CommandRequest through the same
 * orchestrator path everything else uses, so the deny-list, hash-pinning,
 * and tier allowlist in apps/agent-node/src/exec/executor.ts are what
 * actually decide whether anything runs — never this component.
 */
export function TerminalPanel({ assetId, operatorId }: Props) {
  const [input, setInput] = useState("");
  const [tier, setTier] = useState<"T2" | "T3">("T2");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  async function dispatch(command: string, chosenTier: "T2" | "T3") {
    setLog((l) => [...l, { command, tier: chosenTier, status: "pending" }]);
    const res = await fetch(`${CONTROL_PLANE_URL}/v1/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assetIds: [assetId],
        operatorId,
        kind: "adhoc_powershell",
        adhocCommand: command,
        tier: chosenTier,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setLog((l) => l.map((e) => (e.command === command && e.status === "pending" ? { ...e, status: "refused", detail: body.reason } : e)));
      return;
    }
    setLog((l) => l.map((e) => (e.command === command && e.status === "pending" ? { ...e, status: "dispatched" } : e)));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    // T3 (remediate — restarts a service, clears a queue, etc.) is a
    // materially different action than T2 (diagnose, read-only) and per
    // the plan is confirmed before dispatch, not fired straight from the
    // input box.
    if (tier === "T3") {
      setConfirming(input);
      return;
    }
    dispatch(input, tier);
    setInput("");
  }

  return (
    <div className="flex flex-col h-full p-4 gap-3 font-mono text-sm">
      <div className="flex-1 overflow-auto bg-black/40 rounded p-3 space-y-1">
        {log.length === 0 && <div className="text-gray-600">No commands run this session.</div>}
        {log.map((entry, i) => (
          <div key={i}>
            <span className="text-gray-500">[{entry.tier}]</span>{" "}
            <span className={entry.status === "refused" ? "text-critical" : "text-gray-200"}>{entry.command}</span>
            {entry.status === "refused" && <span className="text-critical"> — refused: {entry.detail}</span>}
            {entry.status === "dispatched" && <span className="text-healthy"> — dispatched</span>}
          </div>
        ))}
      </div>

      {confirming && (
        <div className="bg-warning/10 border border-warning/40 rounded p-3 text-xs">
          <div className="mb-2">
            Proposed action<br />
            <span className="text-gray-400">Command:</span> {confirming}<br />
            <span className="text-gray-400">Tier:</span> T3 Remediate
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                dispatch(confirming, "T3");
                setConfirming(null);
                setInput("");
              }}
              className="px-2 py-1 rounded bg-warning/80 hover:bg-warning text-black"
            >
              Run
            </button>
            <button onClick={() => setConfirming(null)} className="px-2 py-1 rounded bg-white/10">
              Cancel
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <select
          value={tier}
          onChange={(e) => setTier(e.target.value as "T2" | "T3")}
          className="bg-white/5 border border-white/10 rounded px-2 text-xs"
        >
          <option value="T2">T2 Diagnose</option>
          <option value="T3">T3 Remediate</option>
        </select>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Get-Service -Name Spooler"
          className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1"
        />
        <button type="submit" className="px-3 py-1 rounded bg-white/10 hover:bg-white/20">
          Run
        </button>
      </form>
    </div>
  );
}
