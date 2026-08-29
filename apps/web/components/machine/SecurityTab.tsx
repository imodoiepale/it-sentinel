"use client";

import { formatTimestamp, type TelemetrySnapshot } from "../../lib/useMachineTelemetry";
import { EmptyResult, Facts, Flag, Section, TabBody, Wide } from "./ui";

/*
 * Defender pulls signatures several times a day, so a day-old definition set
 * is a machine that has stopped updating, and three days is a machine that
 * is meaningfully unprotected against anything recent. The voice route does
 * not threshold this at all — it reads the number out — so these bands exist
 * only to colour the console, never to contradict what voice says.
 */
const DEFINITIONS_WARN_HOURS = 24;
const DEFINITIONS_BAD_HOURS = 72;

export function SecurityTab({ payload }: { payload: TelemetrySnapshot }) {
  const s = payload.security;

  if (!s) {
    return (
      <TabBody>
        <Wide>
          <Section title="Endpoint protection">
            <EmptyResult>This heartbeat carried no endpoint protection section.</EmptyResult>
          </Section>
        </Wide>
      </TabBody>
    );
  }

  const ageHours = s.definitionsAgeHours;
  const definitionsTone =
    ageHours === undefined ? "muted" : ageHours >= DEFINITIONS_BAD_HOURS ? "bad" : ageHours >= DEFINITIONS_WARN_HOURS ? "warn" : "ok";

  /*
   * firewallProfilesEnabled defaults to [] in the contract and agent-node
   * never sets it, so an empty array from this collector means "nobody
   * looked", not "every profile is off". Painting an untested firewall red
   * would send a technician chasing a fault that does not exist.
   */
  const firewallUnreported = payload.collector === "agent-node" || (s.firewallProfilesEnabled ?? []).length === 0;

  return (
    <TabBody>
      <Wide>
        <Section title="Endpoint protection">
          {!s.serviceRunning ? (
            <Flag tone="bad">{s.product ?? "The endpoint protection service"} is not running. This machine is unprotected.</Flag>
          ) : !s.protectionEnabled ? (
            <Flag tone="bad">Real-time protection is switched off.</Flag>
          ) : definitionsTone === "bad" ? (
            <Flag tone="bad">
              Definitions are {Math.round(ageHours!)} hours old. Protection is running against a signature
              set that is days behind.
            </Flag>
          ) : definitionsTone === "warn" ? (
            <Flag tone="warn">Definitions are {Math.round(ageHours!)} hours old — this machine has not pulled an update today.</Flag>
          ) : s.tamperProtectionEnabled === false ? (
            <Flag tone="warn">Tamper protection is off, so the settings above can be changed by anything running locally.</Flag>
          ) : (
            <Flag tone="ok">{s.product ?? "Endpoint protection"} is running with current definitions.</Flag>
          )}

          <Facts
            items={[
              { label: "Product", value: s.product ?? "not identified", tone: s.product ? "plain" : "muted" },
              {
                label: "Reported status",
                value: s.status,
                tone: s.status === "healthy" ? "ok" : s.status === "unknown" ? "muted" : "bad",
              },
              {
                label: "Service",
                value: s.serviceRunning ? "running" : "stopped",
                tone: s.serviceRunning ? "ok" : "bad",
              },
              {
                label: "Real-time protection",
                value: s.protectionEnabled ? "on" : "off",
                tone: s.protectionEnabled ? "ok" : "bad",
              },
              {
                label: "Definitions age",
                value: ageHours !== undefined ? `${ageHours} hours` : "not reported",
                tone: definitionsTone,
              },
              {
                label: "Tamper protection",
                value:
                  s.tamperProtectionEnabled === undefined ? "not reported" : s.tamperProtectionEnabled ? "on" : "off",
                tone: s.tamperProtectionEnabled === undefined ? "muted" : s.tamperProtectionEnabled ? "ok" : "warn",
              },
              {
                label: "Last scan",
                value: s.lastScanAt ? formatTimestamp(s.lastScanAt) : "not reported",
                tone: s.lastScanAt ? "plain" : "muted",
                note: s.lastScanAt ? undefined : "The collector does not read scan history.",
              },
              {
                label: "Firewall profiles",
                value: firewallUnreported ? "not reported" : (s.firewallProfilesEnabled ?? []).join(", "),
                tone: firewallUnreported ? "muted" : "ok",
                note: firewallUnreported
                  ? "This collector never checks the firewall. Blank here means nobody looked, not that the firewall is off."
                  : undefined,
              },
            ]}
          />
        </Section>
      </Wide>
    </TabBody>
  );
}
