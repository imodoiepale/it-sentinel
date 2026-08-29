"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  relayUrl: string;
  mode: "view" | "control";
}

/**
 * noVNC binding (MPL-2.0, unmodified dependency — see the plan's clean-room
 * provenance rule: noVNC is used as-is here, never a source we copy from).
 * The relayUrl is a brokered wss:// URL bound to a single-use token from
 * session.service.ts — this component never sees, requests, or handles a
 * VNC password. view-only mode maps to RFB's viewOnly flag; there is no
 * client-side way to escalate a view session into control.
 */
export function NoVncCanvas({ relayUrl, mode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected" | "error">("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let rfb: any;
    let cancelled = false;

    import("@novnc/novnc").then((mod) => {
      if (cancelled || !containerRef.current) return;
      const RFB = mod.default;
      rfb = new RFB(containerRef.current, relayUrl, { viewOnly: mode === "view" });
      rfb.addEventListener("connect", () => setStatus("connected"));
      rfb.addEventListener("disconnect", (e: any) => {
        setStatus("disconnected");
        if (e.detail && !e.detail.clean) setErrorMessage("Connection lost unexpectedly.");
      });
      rfb.addEventListener("securityfailure", () => {
        setStatus("error");
        setErrorMessage("Authentication with the branch machine failed.");
      });
    });

    return () => {
      cancelled = true;
      rfb?.disconnect();
    };
  }, [relayUrl, mode]);

  return (
    <div className="flex flex-col h-full">
      {/*
        The audit notice cannot be dismissed and cannot be quiet. It carries
        the critical ink rather than inheriting body colour so it stays a
        warning on a white page as much as on a black one.
      */}
      <div className="px-3 py-1.5 bg-critical/10 border-b border-critical/40 text-xs flex items-center justify-between gap-3 shrink-0">
        <span className="font-medium text-critical-ink">
          <span aria-hidden>● </span>Session being audited{mode === "view" ? " — view only" : ""}
        </span>
        <span className="text-muted">
          {status === "connecting" && "Connecting…"}
          {status === "connected" && "Connected"}
          {status === "disconnected" && "Disconnected"}
          {status === "error" && (errorMessage ?? "Error")}
        </span>
      </div>
      <div ref={containerRef} className="flex-1 bg-black" />
    </div>
  );
}
