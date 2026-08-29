"use client";

import { formatDuration, formatTimestamp, type TelemetrySnapshot } from "../../lib/useMachineTelemetry";
import { EmptyResult, Facts, Flag, NotCollected, Scroller, Section, TabBody, TD, TH, TR, Wide } from "./ui";

/*
 * A machine that has not rebooted in a month has not taken a cumulative
 * update either. This is a nudge, not a fault — some of these are servers.
 */
const LONG_UPTIME_DAYS = 30;

export function SoftwareTab({ payload }: { payload: TelemetrySnapshot }) {
  const w = payload.windows;
  const u = payload.updates;
  const vnc = payload.tightVncDetail;
  const email = payload.emailDetail;
  const apps = payload.applications ?? [];

  const uptimeDays = w ? w.uptimeSeconds / 86_400 : 0;
  const rebootPending = w?.rebootPending || u?.rebootPending;

  /*
   * agent-node hardcodes pendingSecurityCount and failedCount to zero — it
   * reads the total from Microsoft.Update.Searcher and never classifies the
   * results. A green "0 security updates pending" from that is a fabricated
   * reassurance, so those two fields are reported as unclassified for this
   * collector rather than as zeroes.
   */
  const updatesUnclassified = payload.collector === "agent-node";

  return (
    <TabBody>
      <Section title="Operating system">
        {rebootPending && <Flag tone="warn">A reboot is pending. Updates will not finish applying until it happens.</Flag>}
        {uptimeDays >= LONG_UPTIME_DAYS && (
          <Flag tone="warn">Up for {Math.floor(uptimeDays)} days without a restart.</Flag>
        )}
        {w ? (
          <Facts
            items={[
              { label: "Windows", value: w.version },
              { label: "Build", value: w.build },
              {
                label: "Activation",
                value: w.activationStatus,
                tone: w.activationStatus === "licensed" ? "ok" : w.activationStatus === "unknown" ? "muted" : "bad",
                note:
                  w.activationStatus === "unknown"
                    ? "The collector does not query the licensing service, so this is always unknown — not a sign the machine is unlicensed."
                    : undefined,
              },
              { label: "Uptime", value: formatDuration(w.uptimeSeconds) },
              {
                label: "Reboot pending",
                value: w.rebootPending ? "yes" : "no",
                tone: w.rebootPending ? "warn" : "ok",
              },
            ]}
          />
        ) : (
          <EmptyResult>This heartbeat carried no Windows section.</EmptyResult>
        )}
      </Section>

      <Section title="Windows Update">
        {u ? (
          <Facts
            items={[
              {
                label: "Updates pending",
                value: u.pendingCount,
                tone: u.pendingCount > 0 ? "warn" : "ok",
                note: "Refreshed hourly on the machine, not per heartbeat — the search is too slow to run every beat.",
              },
              {
                label: "Security updates pending",
                value: updatesUnclassified ? "not classified" : u.pendingSecurityCount,
                tone: updatesUnclassified ? "muted" : u.pendingSecurityCount > 0 ? "bad" : "ok",
                note: updatesUnclassified
                  ? "This collector reports a total only; it does not separate security updates out."
                  : undefined,
              },
              {
                label: "Failed installs",
                value: updatesUnclassified ? "not tracked" : u.failedCount,
                tone: updatesUnclassified ? "muted" : u.failedCount > 0 ? "bad" : "ok",
                note: updatesUnclassified ? "This collector does not read the update install history." : undefined,
              },
              { label: "Reboot pending", value: u.rebootPending ? "yes" : "no", tone: u.rebootPending ? "warn" : "ok" },
            ]}
          />
        ) : (
          <EmptyResult>This heartbeat carried no update section.</EmptyResult>
        )}
      </Section>

      <Section title="Remote access (TightVNC)">
        {vnc ? (
          <>
            {vnc.installed && !vnc.serviceRunning && (
              <Flag tone="bad">TightVNC is installed but its service is stopped — a remote session will not connect.</Flag>
            )}
            {vnc.serviceRunning && !vnc.portReachable && (
              <Flag tone="warn">The service is running but port 5900 did not answer within a second.</Flag>
            )}
            <Facts
              items={[
                { label: "Installed", value: vnc.installed ? "yes" : "no", tone: vnc.installed ? "ok" : "muted" },
                {
                  label: "Service",
                  value: vnc.serviceRunning ? "running" : "stopped",
                  tone: vnc.serviceRunning ? "ok" : vnc.installed ? "bad" : "muted",
                },
                {
                  label: "Port 5900",
                  value: vnc.portReachable ? "reachable" : "not reachable",
                  tone: vnc.portReachable ? "ok" : vnc.installed ? "bad" : "muted",
                },
                { label: "Version", value: vnc.version ?? "not reported", tone: vnc.version ? "plain" : "muted" },
              ]}
            />
          </>
        ) : (
          <EmptyResult>This heartbeat carried no TightVNC section.</EmptyResult>
        )}
      </Section>

      <Section title="Email client">
        {email ? (
          <>
            {email.status === "unknown" && (
              <Flag tone="muted">
                No mail probe runs on this machine. The collector looks for a running Outlook process and
                reports the rest as false without testing it, so only the first row below is measured.
              </Flag>
            )}
            <Facts
              items={[
                {
                  label: "Outlook running",
                  value: email.processRunning ? "yes" : "no",
                  tone: email.processRunning ? "ok" : "muted",
                },
                {
                  label: "Profile configured",
                  value: email.status === "unknown" ? "not probed" : email.profileConfigured ? "yes" : "no",
                  tone: email.status === "unknown" ? "muted" : email.profileConfigured ? "ok" : "bad",
                },
                {
                  label: "Server reachable",
                  value: email.status === "unknown" ? "not probed" : email.serverReachable ? "yes" : "no",
                  tone: email.status === "unknown" ? "muted" : email.serverReachable ? "ok" : "bad",
                },
                {
                  label: "Authentication",
                  value: email.status === "unknown" ? "not probed" : email.authOk ? "ok" : "failing",
                  tone: email.status === "unknown" ? "muted" : email.authOk ? "ok" : "bad",
                },
                {
                  label: "Last sync",
                  value: email.lastSyncAt ? formatTimestamp(email.lastSyncAt) : "not reported",
                  tone: email.lastSyncAt ? "plain" : "muted",
                },
                {
                  label: "Send/receive errors",
                  value: email.status === "unknown" ? "not counted" : email.sendReceiveErrors,
                  tone: email.status === "unknown" ? "muted" : email.sendReceiveErrors > 0 ? "warn" : "ok",
                },
              ]}
            />
          </>
        ) : (
          <EmptyResult>This heartbeat carried no email section.</EmptyResult>
        )}
      </Section>

      <Wide>
        <Section title="Installed software">
          {apps.length > 0 ? (
            <Scroller>
              <table className="w-full text-sm">
                <caption className="sr-only">Software installed on this machine</caption>
                <thead>
                  <tr className="border-b border-white/10">
                    <th scope="col" className={TH}>
                      Name
                    </th>
                    <th scope="col" className={TH}>
                      Version
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {apps.map((a) => (
                    <tr key={`${a.name}-${a.version ?? ""}`} className={TR}>
                      <td className={TD}>{a.name}</td>
                      <td className={`${TD} text-muted`}>{a.version ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          ) : (
            <NotCollected heading="The collector does not gather installed software.">
              <p>
                The heartbeat's <code className="font-mono text-xs">applications</code> array is sent
                empty on every beat — the agent hardcodes it rather than reading the uninstall registry.
                There is no software inventory in IT Sentinel to be out of date; there is none at all.
              </p>
              <p>
                The sections above are the exception: Windows, TightVNC, Outlook, Enquest and the endpoint
                protection product are individually probed by name because the fleet is watched for them
                specifically. Everything else installed on this machine is invisible here.
              </p>
            </NotCollected>
          )}
        </Section>
      </Wide>
    </TabBody>
  );
}
