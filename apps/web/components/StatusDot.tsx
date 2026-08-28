const COLOR: Record<string, string> = {
  healthy: "bg-healthy",
  warning: "bg-warning",
  critical: "bg-critical",
  stale: "bg-stale",
  unknown: "bg-unknown",
};

/**
 * Status is never rendered as color alone — every dot carries an
 * accessible label too, and "stale" is visually and textually distinct
 * from "healthy". Never collapse the two, per the plan's staleness rule.
 */
export function StatusDot({ status, label }: { status: string; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={label ?? status}>
      <span className={`h-2.5 w-2.5 rounded-full ${COLOR[status] ?? COLOR.unknown}`} aria-hidden />
      <span className="sr-only">{status}</span>
    </span>
  );
}
