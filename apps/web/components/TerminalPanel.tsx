"use client";

import { useState } from "react";
import { CONTROL_PLANE_URL } from "../lib/supabase";

interface Props {
  assetId: string;
  operatorId: string;
}

type Tier = "T2" | "T3" | "T4";

interface LogEntry {
  command: string;
  tier: Tier;
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
 *
 * T4 (Operator Console) is the one tier with no cmdlet allowlist behind it.
 * It is unlocked per command by re-entering the operator's password, and the
 * token that returns is single-use and expires in five minutes — so this
 * component holds no elevation between commands and there is no "elevated
 * mode" a walked-away session can be left sitting in.
 */
export function TerminalPanel({ assetId, operatorId }: Props) {
  const [input, setInput] = useState("");
  const [tier, setTier] = useState<Tier>("T2");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmingTier, setConfirmingTier] = useState<Tier>("T3");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);

  async function dispatch(command: string, chosenTier: Tier, elevationToken?: string) {
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
        // Omitted entirely below T4, so a T2/T3 body is byte-identical to
        // what this panel has always sent.
        ...(elevationToken ? { elevationToken } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setLog((l) => l.map((e) => (e.command === command && e.status === "pending" ? { ...e, status: "refused", detail: body.reason ?? body.error } : e)));
      return;
    }
    setLog((l) => l.map((e) => (e.command === command && e.status === "pending" ? { ...e, status: "dispatched" } : e)));
  }

  /**
   * Exchanges the password for a single-use elevation token. The password
   * lives in component state only for the moment the dialog is open and is
   * cleared on every exit path, success or failure — it is never put in the
   * log, never in a URL, and never sent anywhere but /v1/auth/reauth.
   */
  async function elevateAndDispatch(command: string) {
    setBusy(true);
    setAuthError(null);
    try {
      const res = await fetch(`${CONTROL_PLANE_URL}/v1/auth/reauth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, operatorId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAuthError(
          res.status === 429
            ? `Too many failed attempts. Try again in ${body.retryAfterSeconds ?? 900} seconds.`
            : res.status === 503
              ? "Re-authentication is not configured on this control plane, so T4 is unavailable."
              : "Re-authentication failed.",
        );
        return;
      }
      setPassword("");
      setConfirming(null);
      setInput("");
      await dispatch(command, "T4", body.elevationToken);
    } catch {
      setAuthError("Could not reach the control plane.");
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    // T3 (remediate — restarts a service, clears a queue, etc.) is a
    // materially different action than T2 (diagnose, read-only) and per
    // the plan is confirmed before dispatch, not fired straight from the
    // input box. T4 reuses that same read-back and adds the password
    // prompt: the read-back is what stops the wrong command reaching an
    // elevated dispatch, which the password says nothing about.
    if (tier === "T3" || tier === "T4") {
      setConfirming(input);
      setConfirmingTier(tier);
      setAuthError(null);
      setPassword("");
      return;
    }
    dispatch(input, tier);
    setInput("");
  }

  const elevated = confirmingTier === "T4";

  return (
    <div className="flex flex-col h-full p-4 gap-3 font-mono text-sm">
      <div className="flex-1 overflow-auto bg-surface rounded-lg border border-line p-3 space-y-1">
        {log.length === 0 && <div className="text-muted">No commands run this session.</div>}
        {log.map((entry, i) => (
          <div key={i}>
            <span className={entry.tier === "T4" ? "text-critical-ink" : "text-muted"}>[{entry.tier}]</span>{" "}
            <span className={entry.status === "refused" ? "text-critical-ink" : "text-ink-soft"}>{entry.command}</span>
            {entry.status === "refused" && <span className="text-critical-ink"> — refused: {entry.detail}</span>}
            {entry.status === "dispatched" && <span className="text-healthy-ink"> — dispatched</span>}
          </div>
        ))}
      </div>

      {confirming && (
        <div
          className={
            elevated
              ? "bg-critical/10 border border-critical/50 rounded p-3 text-xs"
              : "bg-warning/10 border border-warning/40 rounded p-3 text-xs"
          }
        >
          <div className="mb-2">
            Proposed action<br />
            <span className="text-ink-soft">Command:</span> {confirming}<br />
            <span className="text-ink-soft">Tier:</span> {elevated ? "T4 Operator Console — ELEVATED" : "T3 Remediate"}
          </div>

          {elevated && (
            <>
              <div className="mb-2 text-critical-ink">
                T4 runs this command as typed, with no cmdlet allowlist. The T6 deny-list still
                applies and cannot be waived. This dispatch is attributed to you and written to the
                audit log.
              </div>
              <div className="mb-2 text-ink-soft">
                Re-enter your operator password. It unlocks this one command for five minutes.
              </div>
              <div className="flex flex-col gap-1 mb-2">
                <input
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="operator email"
                  className="bg-surface-2 border border-line rounded px-2 py-1 text-ink placeholder:text-muted"
                />
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="password"
                  className="bg-surface-2 border border-line rounded px-2 py-1 text-ink placeholder:text-muted"
                />
              </div>
              {authError && <div className="mb-2 text-critical-ink">{authError}</div>}
            </>
          )}

          <div className="flex gap-2">
            <button
              disabled={busy || (elevated && (!email || !password))}
              onClick={() => {
                if (elevated) {
                  void elevateAndDispatch(confirming);
                  return;
                }
                dispatch(confirming, "T3");
                setConfirming(null);
                setInput("");
              }}
              className={
                elevated
                  ? "px-2 py-1 rounded bg-critical hover:bg-critical-ink text-on-solid disabled:opacity-40"
                  : "px-2 py-1 rounded bg-warning hover:bg-warning-ink text-on-solid disabled:opacity-40"
              }
            >
              {busy ? "Authenticating…" : elevated ? "Re-authenticate and run" : "Run"}
            </button>
            <button
              onClick={() => {
                setConfirming(null);
                setPassword("");
                setAuthError(null);
              }}
              className="px-2 py-1 rounded bg-surface-2"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <select
          value={tier}
          onChange={(e) => setTier(e.target.value as Tier)}
          className={
            tier === "T4"
              ? "bg-critical/20 border border-critical/50 rounded px-2 text-xs"
              : "bg-surface-2 border border-line rounded px-2 text-xs"
          }
        >
          <option value="T2">T2 Diagnose</option>
          <option value="T3">T3 Remediate</option>
          <option value="T4">T4 Operator Console (password)</option>
        </select>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={tier === "T4" ? "any PowerShell — password required, audited" : "Get-Service -Name Spooler"}
          className="flex-1 bg-surface-2 border border-line rounded-md px-2 py-1.5 text-ink placeholder:text-muted"
        />
        <button type="submit" className="px-3 py-1.5 rounded-md bg-surface-2 hover:bg-surface-3">
          Run
        </button>
      </form>
    </div>
  );
}
