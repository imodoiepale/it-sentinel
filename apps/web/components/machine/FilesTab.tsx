"use client";

import { gib, type TelemetrySnapshot } from "../../lib/useMachineTelemetry";
import { EmptyResult, Flag, Meter, NotCollected, Section, TabBody, Wide } from "./ui";

/*
 * The same two lines the rest of the product uses: the voice route calls a
 * volume "tight" under 15% free, and the fleet summary alerts at 10%. Keeping
 * both means this tab warns at the point voice would mention it out loud and
 * turns red at the point something is already alerting.
 */
const DISK_TIGHT_PERCENT = 15;
const DISK_CRITICAL_PERCENT = 10;

export function FilesTab({ payload }: { payload: TelemetrySnapshot }) {
  const volumes = payload.storage?.volumes ?? [];
  const critical = volumes.filter((v) => v.freePercent < DISK_CRITICAL_PERCENT);
  const tight = volumes.filter((v) => v.freePercent >= DISK_CRITICAL_PERCENT && v.freePercent < DISK_TIGHT_PERCENT);
  const smartFailing = volumes.filter((v) => v.smartHealthy === false);
  const anySmart = volumes.some((v) => v.smartHealthy !== undefined);

  return (
    <TabBody>
      <Wide>
        <Section
          title="Volumes"
          hint="Disk space is the only storage fact the collector reports. There is no file listing behind this tab."
        >
          {volumes.length === 0 ? (
            <EmptyResult>This heartbeat carried no volumes.</EmptyResult>
          ) : (
            <>
              {smartFailing.length > 0 && (
                <Flag tone="bad">
                  SMART reports {smartFailing.map((v) => v.drive).join(", ")} as unhealthy. Back the machine
                  up before doing anything else with it.
                </Flag>
              )}
              {critical.length > 0 ? (
                <Flag tone="bad">
                  {critical.map((v) => `${v.drive} has ${v.freePercent.toFixed(1)}% free (${gib(v.freeMb)})`).join("; ")}.
                  Windows starts failing updates and profile writes around here.
                </Flag>
              ) : tight.length > 0 ? (
                <Flag tone="warn">
                  {tight.map((v) => `${v.drive} is down to ${v.freePercent.toFixed(1)}% free (${gib(v.freeMb)})`).join("; ")}.
                </Flag>
              ) : (
                <Flag tone="ok">All {volumes.length} volume{volumes.length === 1 ? " has" : "s have"} healthy free space.</Flag>
              )}

              {volumes.map((v) => (
                <Meter
                  key={v.drive}
                  label={`${v.drive} ${gib(v.capacityMb)}${
                    v.smartHealthy === undefined ? "" : v.smartHealthy ? " · SMART healthy" : " · SMART failing"
                  }`}
                  // The bar fills with what is used, so a nearly full disk is
                  // a nearly full bar — the shape an operator expects.
                  percent={100 - v.freePercent}
                  tone={
                    v.smartHealthy === false || v.freePercent < DISK_CRITICAL_PERCENT
                      ? "bad"
                      : v.freePercent < DISK_TIGHT_PERCENT
                        ? "warn"
                        : "ok"
                  }
                  caption={`${gib(v.freeMb)} free · ${v.freePercent.toFixed(1)}%`}
                />
              ))}

              {!anySmart && (
                <p className="mt-3 text-xs text-muted">
                  SMART health is not reported by this collector, so drive failure will not be visible here
                  before it happens.
                </p>
              )}
            </>
          )}
        </Section>

        <Section title="File browser">
          <NotCollected heading="There is no file listing in IT Sentinel.">
            <p>
              Nothing in the heartbeat contract describes files or folders, and no collector walks the
              disk — so there is no directory tree to render here, stale or otherwise. This tab shows the
              storage facts that do exist and stops there.
            </p>
            <p>
              To look at the file system on this machine, use the Terminal tab, which runs against the
              machine itself through the command orchestrator and is audited like any other action.
            </p>
          </NotCollected>
        </Section>
      </Wide>
    </TabBody>
  );
}
