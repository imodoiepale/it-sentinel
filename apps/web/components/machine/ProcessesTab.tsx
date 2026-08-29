"use client";

import { formatDuration, gib, type TelemetrySnapshot } from "../../lib/useMachineTelemetry";
import { EmptyResult, Facts, Flag, Meter, NotCollected, Scroller, Section, TabBody, TD, TH, TR, Wide } from "./ui";

/*
 * Load thresholds. Deliberately looser than the fleet table's alerting: this
 * tab answers "is this machine struggling right now", where a brief 80% CPU
 * spike is normal and only sustained pressure is worth a colour.
 */
const RAM_WARN = 85;
const RAM_BAD = 93;
const CPU_WARN = 80;
const CPU_BAD = 92;

function tone(value: number, warn: number, bad: number) {
  return value >= bad ? "bad" : value >= warn ? "warn" : "ok";
}

export function ProcessesTab({ payload }: { payload: TelemetrySnapshot }) {
  const cpu = payload.cpu;
  const ram = payload.ram;
  const user = payload.user;
  const consumers = ram?.topConsumers ?? [];

  const ramUsage = ram?.usagePercent ?? payload.ramUsage;
  const ramTone = ramUsage === undefined ? "muted" : tone(ramUsage, RAM_WARN, RAM_BAD);
  const cpuTone = cpu?.usagePercent === undefined ? "muted" : tone(cpu.usagePercent, CPU_WARN, CPU_BAD);

  return (
    <TabBody>
      <Section title="Load">
        {ramTone === "bad" && (
          <Flag tone="bad">
            Memory is at {Math.round(ramUsage!)}% with only {gib(ram?.availableMb)} free. This machine will
            be paging.
          </Flag>
        )}
        {cpuTone === "bad" && <Flag tone="bad">CPU was pegged at {Math.round(cpu!.usagePercent)}% when this was sampled.</Flag>}

        {cpu?.usagePercent !== undefined && (
          <Meter label="CPU" percent={cpu.usagePercent} tone={cpuTone} caption={`${Math.round(cpu.usagePercent)}% busy`} />
        )}
        {ramUsage !== undefined && (
          <Meter
            label="Memory"
            percent={ramUsage}
            tone={ramTone}
            caption={`${ramUsage.toFixed(1)}% used · ${gib(ram?.availableMb)} free of ${gib(ram?.installedMb)}`}
          />
        )}

        <div className="mt-4">
          <Facts
            items={[
              { label: "Processor", value: cpu?.model ?? "not reported", tone: cpu?.model ? "plain" : "muted" },
              {
                label: "Cores",
                value: cpu?.coreCount ?? "not reported",
                tone: cpu?.coreCount === undefined ? "muted" : "plain",
              },
              {
                label: "Temperature",
                value: cpu?.temperatureCelsius !== undefined ? `${cpu.temperatureCelsius} °C` : "not measured",
                tone: cpu?.temperatureCelsius === undefined ? "muted" : "plain",
                // Named rather than omitted: an absent temperature reading on
                // a thermal-throttling complaint is itself the finding.
                note:
                  cpu?.temperatureCelsius === undefined
                    ? "The collector does not read thermal sensors."
                    : undefined,
              },
              { label: "Installed memory", value: gib(ram?.installedMb) },
            ]}
          />
        </div>
      </Section>

      <Section title="Signed-in session">
        {user ? (
          <Facts
            items={[
              {
                label: "User",
                value: user.loggedInUser ?? "nobody signed in",
                tone: user.loggedInUser ? "plain" : "muted",
              },
              {
                label: "Session",
                value: user.sessionState,
                tone: user.sessionState === "active" ? "ok" : user.sessionState === "none" ? "muted" : "plain",
              },
              {
                label: "Idle for",
                value: user.idleSeconds !== undefined ? formatDuration(user.idleSeconds) : "not measured",
                tone: user.idleSeconds === undefined ? "muted" : "plain",
                note:
                  user.idleSeconds === undefined
                    ? "The collector reports the session state but not an idle timer."
                    : undefined,
              },
            ]}
          />
        ) : (
          <EmptyResult>No session information in this heartbeat.</EmptyResult>
        )}
      </Section>

      <Wide>
        <Section title="Per-process breakdown">
          {consumers.length > 0 ? (
            <Scroller>
              <table className="w-full text-sm">
                <caption className="sr-only">Processes by memory use on this machine</caption>
                <thead>
                  <tr className="border-b border-line">
                    <th scope="col" className={TH}>
                      Process
                    </th>
                    <th scope="col" className={`${TH} text-right`}>
                      Memory
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {consumers.map((c) => (
                    <tr key={c.process} className={TR}>
                      <td className={TD}>{c.process}</td>
                      <td className={`${TD} text-right tabular-nums`}>{gib(c.mb)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          ) : (
            <NotCollected heading="This collector does not enumerate processes.">
              <p>
                The heartbeat contract has a slot for the top memory consumers
                (<code className="font-mono text-xs">ram.topConsumers</code>), but the Windows collector
                never fills it — it samples the machine's totals only. No heartbeat from this fleet has
                ever carried a process list.
              </p>
              <p>
                Until a process sampler is added to <code className="font-mono text-xs">collect.ps1</code>,
                the aggregate figures above are the whole truth about load here. The Terminal tab reaches
                the machine directly if you need to see what is actually running.
              </p>
            </NotCollected>
          )}
        </Section>
      </Wide>
    </TabBody>
  );
}
