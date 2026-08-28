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
  "Cameras",
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
 * The machine workspace from the plan, plus a Cameras tab. Remote Desktop,
 * Terminal and Cameras are wired to real backends (the relay's session
 * broker and the command orchestrator); the remaining tabs are read
 * surfaces over data the agent already reports in its heartbeat/telemetry
 * — this shell exists so their layout and navigation are in place, ready
 * to be filled in as those data views are built out further.
 */
export function MachineWorkspace({ assetId, hostname, operatorId, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("Remote Desktop");
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<string | null>(null);
  const [openingCamera, setOpeningCamera] = useState(false);

  /**
   * Opens the Windows Camera app on the machine — nothing is captured and
   * no image leaves the endpoint. It goes through /v1/commands like every
   * other action rather than a camera-specific endpoint, so the app
   * allowlist in the agent's app-launcher is what decides what "camera"
   * actually runs.
   */
  async function openCamera() {
    setOpeningCamera(true);
    setCameraStatus(null);
    try {
      const res = await fetch(`${CONTROL_PLANE_URL}/v1/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assetIds: [assetId],
          operatorId,
          kind: "app_launch",
          appId: "camera",
          tier: "T2",
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setCameraStatus(`Refused: ${body.reason ?? `request failed (${res.status})`}`);
        return;
      }
      // "Dispatched", not "opened": the command is queued for the agent to
      // pick up, and a window appearing on the far end is a separate event
      // this browser never observes.
      setCameraStatus(`Dispatched to ${hostname} at ${new Date().toLocaleTimeString()}.`);
    } finally {
      setOpeningCamera(false);
    }
  }

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

          {activeTab === "Cameras" && (
            <div className="p-8 flex flex-col items-start gap-3">
              <p className="text-sm text-gray-400 max-w-lg">
                Opens the Windows Camera app on {hostname}. Nothing is recorded and no image is sent
                anywhere — the window appears on that machine for the person sitting at it.
              </p>
              <button
                onClick={openCamera}
                disabled={openingCamera}
                className="px-3 py-1.5 rounded bg-healthy/90 hover:bg-healthy text-black text-sm disabled:opacity-50"
              >
                {openingCamera ? "Opening…" : "Open camera on this machine"}
              </button>
              {cameraStatus && (
                <p className={`text-xs ${cameraStatus.startsWith("Refused") ? "text-critical" : "text-gray-400"}`}>
                  {cameraStatus}
                </p>
              )}
            </div>
          )}

          {activeTab !== "Remote Desktop" && activeTab !== "Terminal" && activeTab !== "Cameras" && (
            <div className="p-8 text-sm text-gray-500">
              {activeTab} view — reads from this machine's telemetry and check history once wired to the fleet table's row data.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
