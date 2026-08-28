"use client";

import { useState } from "react";
import { CONTROL_PLANE_URL } from "../lib/supabase";
import { NoVncCanvas } from "./viewer/NoVncCanvas";
import { TerminalPanel } from "./TerminalPanel";

interface Props {
  assetId: string;
  hostname: string;
  operatorId: string;
  onClose: () => void;
}

const TABS = [
  "Remote Desktop",
  "Terminal",
  "Files",
  "Processes",
  "Services",
  "Printers",
  "Network",
  "Logs",
  "Enquest",
  "Software",
  "Security",
  "Tickets",
  "History",
] as const;

type Tab = (typeof TABS)[number];

/**
 * The thirteen-tab machine workspace from the plan. Remote Desktop and
 * Terminal are wired to real backends (the relay's session broker and the
 * command orchestrator, respectively); the remaining tabs are read
 * surfaces over data the agent already reports in its heartbeat/telemetry
 * — this shell exists so their layout and navigation are in place, ready
 * to be filled in as those data views are built out further.
 */
export function MachineWorkspace({ assetId, hostname, operatorId, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("Remote Desktop");
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  async function requestRemoteSession(mode: "view" | "control") {
    setRequesting(true);
    setSessionError(null);
    try {
      const res = await fetch(`${CONTROL_PLANE_URL}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetId, operatorId, mode, reason: `Console session on ${hostname}` }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSessionError(body.reason ?? `Session request failed (${res.status})`);
        return;
      }
      const grant = await res.json();
      setRelayUrl(grant.relayUrl);
    } finally {
      setRequesting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="w-[90vw] h-[85vh] bg-[#0b0f14] border border-white/10 rounded-lg flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <h2 className="font-semibold">{hostname}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white">
            ✕
          </button>
        </div>

        <div className="flex border-b border-white/10 overflow-x-auto shrink-0">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 ${
                activeTab === tab ? "border-healthy text-white" : "border-transparent text-gray-500 hover:text-gray-300"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto">
          {activeTab === "Remote Desktop" &&
            (relayUrl ? (
              <NoVncCanvas relayUrl={relayUrl} mode="control" />
            ) : (
              <div className="p-8 flex flex-col items-center gap-4">
                <p className="text-sm text-gray-400">No active session. Requesting one grants a single-use,
                  audited connection — the password is never sent to this browser.</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => requestRemoteSession("control")}
                    disabled={requesting}
                    className="px-3 py-1.5 rounded bg-healthy/90 hover:bg-healthy text-black text-sm disabled:opacity-50"
                  >
                    {requesting ? "Requesting…" : "Start Remote Session"}
                  </button>
                  <button
                    onClick={() => requestRemoteSession("view")}
                    disabled={requesting}
                    className="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-sm disabled:opacity-50"
                  >
                    View Only
                  </button>
                </div>
                {sessionError && <p className="text-critical text-xs">{sessionError}</p>}
              </div>
            ))}

          {activeTab === "Terminal" && <TerminalPanel assetId={assetId} operatorId={operatorId} />}

          {activeTab !== "Remote Desktop" && activeTab !== "Terminal" && (
            <div className="p-8 text-sm text-gray-500">
              {activeTab} view — reads from this machine's telemetry and check history once wired to the fleet table's row data.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
