"use client";

import { formatAge, formatTimestamp, type MachineTelemetry } from "../../lib/useMachineTelemetry";

/**
 * Every telemetry-backed tab sits under this.
 *
 * Telemetry is a snapshot, and rendering a fifteen-minute-old disk figure as
 * if it were current is exactly the kind of quiet lie this product exists to
 * prevent. So the age is always on screen, and past the staleness line it is
 * a banner above the numbers rather than a footnote below them — an operator
 * has to walk past the warning to reach the reading.
 */
export function TelemetryBanner({ telemetry, hostname }: { telemetry: MachineTelemetry; hostname: string }) {
  const { ageMs, recordedAt, stale, payload, error } = telemetry;

  if (error) {
    return (
      <div role="status" className="px-4 py-2 border-b border-critical/40 bg-critical/10 text-xs text-critical-ink">
        <span className="sr-only">Error: </span>
        Could not read telemetry for {hostname}: {error}
      </div>
    );
  }

  if (!payload) {
    return (
      <div role="status" className="px-4 py-2 border-b border-white/10 text-xs text-warning">
        <span className="sr-only">Warning: </span>
        {hostname} has never sent telemetry. Nothing below is measured — its agent may not be running.
      </div>
    );
  }

  if (!stale) {
    return (
      <div
        role="status"
        aria-live="off"
        className="flex flex-wrap items-center gap-x-3 px-4 py-1.5 border-b border-white/10 text-xs text-muted"
      >
        {/* aria-live is off on purpose: this line changes every few seconds
            as the age ticks up, and announcing "22 seconds old" on a loop
            makes the whole panel unusable with a screen reader. */}
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-healthy animate-breathe" aria-hidden />
          <span className="text-healthy-ink">Live</span>
        </span>
        <span>
          Snapshot {formatAge(ageMs)} old, taken {formatTimestamp(recordedAt)}
        </span>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="px-4 py-2 border-b border-warning/40 bg-warning/10 text-xs text-warning"
    >
      <span className="sr-only">Warning: </span>
      <strong className="font-semibold">Not live.</strong> The newest telemetry from {hostname} is{" "}
      {formatAge(ageMs)} old ({formatTimestamp(recordedAt)}). Every figure below describes the machine as
      it was then, not as it is now.
    </div>
  );
}
