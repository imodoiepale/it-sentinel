"use client";

import { useEffect, useState } from "react";
import { CONTROL_PLANE_URL } from "../lib/supabase";
import { useMachineActivity, useMachineTelemetry } from "../lib/useMachineTelemetry";
import { NoVncCanvas } from "./viewer/NoVncCanvas";
import { TerminalPanel } from "./TerminalPanel";
import { EnquestTab } from "./machine/EnquestTab";
import { FilesTab } from "./machine/FilesTab";
import { HistoryTab } from "./machine/HistoryTab";
import { LogsTab } from "./machine/LogsTab";
import { NetworkTab } from "./machine/NetworkTab";
import { PrintersTab } from "./machine/PrintersTab";
import { ProcessesTab } from "./machine/ProcessesTab";
import { SecurityTab } from "./machine/SecurityTab";
import { ServicesTab } from "./machine/ServicesTab";
import { SoftwareTab } from "./machine/SoftwareTab";
import { TelemetryBanner } from "./machine/TelemetryBanner";
import { TicketsTab } from "./machine/TicketsTab";

interface Props {
  assetId: string;
  hostname: string;
  operatorId: string;
  onClose: () => void;
}

const TAB_GROUPS = [
  { label: "Control", tabs: ["Remote Desktop", "Terminal", "Cameras"] },
  { label: "Machine", tabs: ["Processes", "Services", "Files", "Software"] },
  { label: "Ops", tabs: ["Network", "Printers", "Logs", "Enquest", "Security"] },
  { label: "Record", tabs: ["Tickets", "History"] },
] as const;

type Tab = (typeof TAB_GROUPS)[number]["tabs"][number];

/**
 * Tabs whose content is a reading of the newest heartbeat, and which
 * therefore must sit under the staleness banner. Tickets and History are
 * excluded deliberately: an incident from last month is not stale, it is
 * history, and warning about its age would train operators to ignore the
 * warning on the tabs where age genuinely changes the meaning.
 */
const TELEMETRY_TABS = new Set<Tab>([
  "Files",
  "Processes",
  "Services",
  "Printers",
  "Network",
  "Logs",
  "Enquest",
  "Software",
  "Security",
]);

/**
 * The machine workspace from the plan, plus a Cameras tab.
 *
 * Remote Desktop, Terminal and Cameras act on the machine through the
 * session broker and the command orchestrator. Every other tab is a read of
 * data the agent already sends: ingest writes the whole HeartbeatPayload
 * into telemetry.payload on every beat, and these tabs render it rather than
 * collecting anything new.
 *
 * Where a tab has no backing data it says which — plainly and specifically,
 * naming the field and the collector — instead of implying the data is on
 * its way. Half the value of this panel is knowing what the fleet does not
 * watch.
 */
export function MachineWorkspace({ assetId, hostname, operatorId, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("Remote Desktop");
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<string | null>(null);
  const [openingCamera, setOpeningCamera] = useState(false);

  const telemetry = useMachineTelemetry(assetId);
  const activity = useMachineActivity(assetId);
  const payload = telemetry.payload;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
        return;
      }
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  const identity = payload?.machine;
  const subtitle = [identity?.model, identity?.ip, payload?.user?.loggedInUser].filter(Boolean).join(" · ");
  const showsTelemetry = TELEMETRY_TABS.has(activeTab);

  /**
   * Renders a telemetry tab, or the reason it cannot be rendered. Kept in
   * one place so "still loading" and "this machine has never reported" can
   * never be mistaken for "this machine has nothing to report" — three
   * states that a per-tab empty check would flatten into one.
   */
  function telemetryTab(render: (p: NonNullable<typeof payload>) => JSX.Element) {
    if (telemetry.loading && !payload) {
      return <p className="p-8 text-sm text-muted">Reading this machine&rsquo;s latest heartbeat…</p>;
    }
    if (!payload) {
      return (
        <div className="p-8 max-w-2xl">
          <p className="text-sm text-gray-200">No telemetry has ever arrived from {hostname}.</p>
          <p className="mt-2 text-sm text-muted">
            Nothing on this tab is unavailable because it is unbuilt — it is unavailable because this
            machine has not reported. Check that the agent is installed and running on it.
          </p>
        </div>
      );
    }
    return render(payload);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-[2px]" aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="machine-workspace-title"
        className="relative w-[min(96vw,80rem)] h-[min(90vh,56rem)] bg-[#0b0f14] border border-white/10 rounded-xl flex flex-col overflow-hidden shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 px-5 py-3.5 border-b border-white/10 bg-[#080b0f]">
          <div className="min-w-0">
            <h2 id="machine-workspace-title" className="font-semibold truncate tracking-tight">
              {hostname}
            </h2>
            {subtitle ? (
              <p className="text-xs text-muted truncate mt-0.5">{subtitle}</p>
            ) : (
              <p className="text-xs text-muted mt-0.5">No identity in the latest heartbeat yet</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-white shrink-0 rounded-md px-2 py-1 text-sm"
            aria-label={`Close ${hostname}`}
          >
            Close
          </button>
        </div>

        <div className="flex border-b border-white/10 overflow-x-auto shrink-0 bg-[#080b0f]/80">
          {TAB_GROUPS.map((group, gi) => (
            <div key={group.label} className="flex items-stretch shrink-0">
              {gi > 0 && <div className="w-px bg-white/10 mx-1 my-2" aria-hidden />}
              <div className="flex flex-col justify-end">
                <span className="px-3 pt-1.5 text-[10px] uppercase tracking-wider text-gray-600">{group.label}</span>
                <div className="flex">
                  {group.tabs.map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setActiveTab(tab)}
                      aria-current={activeTab === tab ? "page" : undefined}
                      className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 ${
                        activeTab === tab
                          ? "border-healthy-ink text-white"
                          : "border-transparent text-gray-500 hover:text-gray-300"
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>

        {showsTelemetry && <TelemetryBanner telemetry={telemetry} hostname={hostname} />}

        <div className="flex-1 overflow-auto min-h-0">
          {activeTab === "Remote Desktop" &&
            (relayUrl ? (
              <NoVncCanvas relayUrl={relayUrl} mode="control" />
            ) : (
              <div className="h-full flex items-center justify-center p-8">
                <div className="max-w-lg rounded-xl border border-white/10 bg-white/[0.03] p-6">
                  <h3 className="text-sm font-medium text-gray-100">No active session</h3>
                  <p className="mt-2 text-sm text-muted leading-relaxed">
                    Requesting one grants a single-use, audited connection — the password is never sent to
                    this browser.
                  </p>
                  <div className="mt-5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => requestRemoteSession("control")}
                      disabled={requesting}
                      className="px-3.5 py-2 rounded-md bg-healthy/90 hover:bg-healthy text-black text-sm font-medium disabled:opacity-50"
                    >
                      {requesting ? "Requesting…" : "Start remote session"}
                    </button>
                    <button
                      type="button"
                      onClick={() => requestRemoteSession("view")}
                      disabled={requesting}
                      className="px-3.5 py-2 rounded-md bg-white/10 hover:bg-white/15 text-sm disabled:opacity-50"
                    >
                      View only
                    </button>
                  </div>
                  {sessionError && <p className="mt-3 text-critical-ink text-xs">{sessionError}</p>}
                </div>
              </div>
            ))}

          {activeTab === "Terminal" && <TerminalPanel assetId={assetId} operatorId={operatorId} />}

          {activeTab === "Cameras" && (
            <div className="h-full flex items-center justify-center p-8">
              <div className="max-w-lg rounded-xl border border-white/10 bg-white/[0.03] p-6">
                <h3 className="text-sm font-medium text-gray-100">Camera on the far end</h3>
                <p className="mt-2 text-sm text-muted leading-relaxed">
                  Opens the Windows Camera app on {hostname}. Nothing is recorded and no image is sent
                  anywhere — the window appears on that machine for the person sitting at it.
                </p>
                <button
                  type="button"
                  onClick={openCamera}
                  disabled={openingCamera}
                  className="mt-5 px-3.5 py-2 rounded-md bg-healthy/90 hover:bg-healthy text-black text-sm font-medium disabled:opacity-50"
                >
                  {openingCamera ? "Opening…" : "Open camera on this machine"}
                </button>
                {cameraStatus && (
                  <p className={`mt-3 text-xs ${cameraStatus.startsWith("Refused") ? "text-critical-ink" : "text-muted"}`}>
                    {cameraStatus}
                  </p>
                )}
              </div>
            </div>
          )}

          {activeTab === "Files" && telemetryTab((p) => <FilesTab payload={p} />)}
          {activeTab === "Processes" && telemetryTab((p) => <ProcessesTab payload={p} />)}
          {activeTab === "Services" && telemetryTab((p) => <ServicesTab payload={p} />)}
          {activeTab === "Printers" && telemetryTab((p) => <PrintersTab payload={p} checks={telemetry.checks} />)}
          {activeTab === "Network" && telemetryTab((p) => <NetworkTab payload={p} />)}
          {activeTab === "Logs" && telemetryTab((p) => <LogsTab payload={p} />)}
          {activeTab === "Enquest" && telemetryTab((p) => <EnquestTab payload={p} />)}
          {activeTab === "Software" && telemetryTab((p) => <SoftwareTab payload={p} />)}
          {activeTab === "Security" && telemetryTab((p) => <SecurityTab payload={p} />)}
          {activeTab === "Tickets" && <TicketsTab activity={activity} />}
          {activeTab === "History" && <HistoryTab activity={activity} checks={telemetry.checks} />}
        </div>
      </div>
    </div>
  );
}
