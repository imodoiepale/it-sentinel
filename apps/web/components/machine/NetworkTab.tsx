"use client";

import type { TelemetrySnapshot } from "../../lib/useMachineTelemetry";
import { EmptyResult, Facts, Flag, Section, TabBody, Wide } from "./ui";

/*
 * Matches the voice route's network judgement so the console and the spoken
 * answer never disagree: reachable internet, a link that is not
 * disconnected, and packet loss under five percent.
 */
const PACKET_LOSS_BAD = 5;

export function NetworkTab({ payload }: { payload: TelemetrySnapshot }) {
  const n = payload.network;
  const machine = payload.machine;

  if (!n) {
    return (
      <TabBody>
        <Wide>
          <Section title="Network">
            <EmptyResult>This heartbeat carried no network section.</EmptyResult>
          </Section>
        </Wide>
      </TabBody>
    );
  }

  const loss = n.packetLossPercent;
  const disconnected = n.linkState === "disconnected";
  // A gateway that answers while the internet does not is the single most
  // useful thing this tab can say: it splits "the machine is off the network"
  // from "the branch's uplink is down", which are different call-outs.
  const gatewayButNoInternet = !disconnected && !!n.gatewayIp && !n.internetReachable;

  return (
    <TabBody>
      <Section title="Link">
        {disconnected && <Flag tone="bad">No network link. This machine is off the network entirely.</Flag>}
        {gatewayButNoInternet && (
          <Flag tone="warn">
            The local link is up and the gateway is {n.gatewayIp}, but the internet reachability probe
            failed. That points upstream of this machine — the branch uplink or the gateway itself — not
            at the workstation.
          </Flag>
        )}
        {loss !== undefined && loss >= PACKET_LOSS_BAD && (
          <Flag tone="bad">Packet loss is {loss}% — anything at or above {PACKET_LOSS_BAD}% will be felt by the user.</Flag>
        )}
        {!disconnected && !gatewayButNoInternet && (loss ?? 0) < PACKET_LOSS_BAD && (
          <Flag tone="ok">Link is {n.linkState} and the internet is reachable.</Flag>
        )}

        <Facts
          items={[
            { label: "Link state", value: n.linkState, tone: disconnected ? "bad" : "ok" },
            {
              label: "Internet reachable",
              value: n.internetReachable ? "yes" : "no",
              tone: n.internetReachable ? "ok" : "bad",
              note: n.internetReachable ? undefined : "The probe is a single ICMP ping, which some networks drop by policy.",
            },
            { label: "IP address", value: machine?.ip ?? "not reported", tone: machine?.ip ? "plain" : "muted" },
            { label: "Gateway", value: n.gatewayIp ?? "none found", tone: n.gatewayIp ? "plain" : "warn" },
            {
              label: "DNS servers",
              value: n.dnsServers?.length ? n.dnsServers.join(", ") : "none reported",
              tone: n.dnsServers?.length ? "plain" : "warn",
            },
            {
              label: "MAC address",
              value: machine?.mac ?? "not collected",
              tone: machine?.mac ? "plain" : "muted",
            },
          ]}
        />
      </Section>

      <Section
        title="Measurements"
        hint="The contract carries slots for all of these. Anything marked not measured is one the Windows collector never fills — it is absent from every heartbeat this fleet has sent, not merely from this one."
      >
        <Facts
          items={[
            {
              label: "Internet latency",
              value: n.internetLatencyMs !== undefined ? `${Math.round(n.internetLatencyMs)} ms` : "not measured",
              tone: n.internetLatencyMs === undefined ? "muted" : "plain",
              note:
                n.internetLatencyMs === undefined && !n.internetReachable
                  ? "The reachability ping failed, so there was no round trip to time."
                  : undefined,
            },
            {
              label: "Gateway latency",
              value: n.latencyMs !== undefined ? `${Math.round(n.latencyMs)} ms` : "not measured",
              tone: n.latencyMs === undefined ? "muted" : "plain",
            },
            {
              label: "Packet loss",
              value: loss !== undefined ? `${loss}%` : "not measured",
              tone: loss === undefined ? "muted" : loss >= PACKET_LOSS_BAD ? "bad" : "ok",
            },
            {
              label: "Link speed",
              value: n.linkSpeedMbps !== undefined ? `${n.linkSpeedMbps} Mbps` : "not measured",
              tone: n.linkSpeedMbps === undefined ? "muted" : "plain",
            },
            {
              label: "Public IP",
              value: n.publicIp ?? "not measured",
              tone: n.publicIp ? "plain" : "muted",
              note: n.publicIp ? undefined : "Discovering it needs an outbound lookup the collector does not make.",
            },
          ]}
        />
      </Section>
    </TabBody>
  );
}
