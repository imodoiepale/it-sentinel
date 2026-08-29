import type { ReactNode } from "react";

/**
 * The shared shell for every machine workspace tab.
 *
 * These exist to keep one distinction visible everywhere: a value that was
 * measured, a value that was measured and is wrong, and a value nobody
 * measured are three different things and must never render alike. Most of
 * the honesty in this panel is enforced here rather than in each tab.
 *
 * Colour is never the only carrier of meaning — every tone renders a word
 * too, which is the same rule StatusDot follows with its sr-only label.
 */

export type Tone = "ok" | "warn" | "bad" | "muted" | "plain";

/*
 * The -ink steps, not the fills. tailwind.config.ts spells out why: the fill
 * teal and red are ~3:1 and ~4:1 on #0b0f14, which is fine behind black
 * button text and unreadable as a foreground colour.
 */
const TONE_TEXT: Record<Tone, string> = {
  ok: "text-healthy-ink",
  warn: "text-warning",
  bad: "text-critical-ink",
  muted: "text-muted",
  plain: "text-gray-200",
};

const TONE_FILL: Record<Tone, string> = {
  ok: "bg-healthy",
  warn: "bg-warning",
  bad: "bg-critical",
  muted: "bg-unknown",
  plain: "bg-white/30",
};

const TONE_BORDER: Record<Tone, string> = {
  ok: "border-healthy/50",
  warn: "border-warning/60",
  bad: "border-critical/60",
  muted: "border-white/15",
  plain: "border-white/15",
};

/** Spoken prefix for anything whose meaning would otherwise be the colour. */
const TONE_WORD: Record<Tone, string> = {
  ok: "OK: ",
  warn: "Warning: ",
  bad: "Problem: ",
  muted: "Not reported: ",
  plain: "",
};

/** The standard two-column tab body. Tabs scroll; the panel does not grow. */
export function TabBody({ children }: { children: ReactNode }) {
  return <div className="p-5 grid gap-4 lg:grid-cols-2 items-start">{children}</div>;
}

/** A section that should span the full width of TabBody's grid. */
export function Wide({ children }: { children: ReactNode }) {
  return <div className="lg:col-span-2 grid gap-4">{children}</div>;
}

export function Section({
  title,
  hint,
  aside,
  children,
}: {
  title: string;
  hint?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.03] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]">
      <header className="flex items-baseline justify-between gap-3 px-3.5 py-2.5 border-b border-white/10">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-gray-500">{title}</h3>
        {aside}
      </header>
      {hint && <p className="px-3.5 pt-2.5 text-xs text-muted">{hint}</p>}
      <div className="p-3.5">{children}</div>
    </section>
  );
}

export interface Fact {
  label: string;
  value: ReactNode;
  tone?: Tone;
  /** Shown under the value — for saying why a number is missing or odd. */
  note?: ReactNode;
}

/**
 * A definition list, not a grid of divs: an operator reading this with a
 * screen reader needs the label bound to its value, and "Gateway" followed
 * by an unattached "172.20.10.1" is not that.
 */
export function Facts({ items }: { items: Fact[] }) {
  return (
    <dl className="text-sm">
      {items.map((f) => (
        <div key={f.label} className="flex flex-wrap items-baseline gap-x-3 py-1 border-b border-white/5 last:border-0">
          <dt className="w-44 shrink-0 text-muted">{f.label}</dt>
          <dd className={`flex-1 min-w-0 break-words ${TONE_TEXT[f.tone ?? "plain"]}`}>
            {f.tone && f.tone !== "plain" && <span className="sr-only">{TONE_WORD[f.tone]}</span>}
            {f.value}
            {f.note && <span className="block text-xs text-muted">{f.note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The anomaly line. Tabs lead with these so the one bad number is the first
 * thing read, rather than being buried in an undifferentiated wall of pairs.
 */
export function Flag({ tone, children }: { tone: Exclude<Tone, "plain">; children: ReactNode }) {
  return (
    <p
      role="status"
      className={`mb-3 border-l-2 pl-2.5 py-0.5 text-sm ${TONE_BORDER[tone]} ${TONE_TEXT[tone]}`}
    >
      <span className="sr-only">{TONE_WORD[tone]}</span>
      {children}
    </p>
  );
}

/**
 * A state word rendered as a badge. The word itself is the meaning, so this
 * needs no sr-only twin — the colour is redundant reinforcement, which is
 * the correct direction.
 */
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs border ${TONE_BORDER[tone]} ${TONE_TEXT[tone]}`}
    >
      {children}
    </span>
  );
}

export function Meter({
  label,
  percent,
  tone,
  caption,
}: {
  label: string;
  percent: number;
  tone: Tone;
  caption: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted">{label}</span>
        <span className={`tabular-nums ${TONE_TEXT[tone]}`}>
          {tone !== "plain" && <span className="sr-only">{TONE_WORD[tone]}</span>}
          {caption}
        </span>
      </div>
      {/* Decoration only: the caption above already carries the number, so a
          screen reader reading the bar as well would just repeat it. */}
      <div className="mt-1 h-1.5 rounded bg-white/10 overflow-hidden" aria-hidden>
        <div className={`h-full ${TONE_FILL[tone]}`} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}

/**
 * The honest empty state, for a tab whose data nothing collects.
 *
 * This is deliberately not phrased as "coming soon". A tab that admits it
 * has no data is honest; one that implies data is on its way when nothing
 * gathers it is the same class of lie as rendering a stale number as live.
 */
export function NotCollected({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-white/15 bg-white/[0.015] p-4">
      <p className="text-sm font-medium text-gray-200">{heading}</p>
      <div className="mt-2 space-y-2 text-sm text-muted max-w-2xl">{children}</div>
    </div>
  );
}

/** An empty result that is a real answer — nothing wrong, nothing to show. */
export function EmptyResult({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

/**
 * Long lists scroll inside the panel rather than stretching it — a machine
 * with forty printers must not push the tab bar off screen.
 */
export function Scroller({ children, max = "max-h-72" }: { children: ReactNode; max?: string }) {
  // Negative margin matched to Section's padding so a scrolled table's rows
  // reach the card edge instead of sitting in a narrower inset column.
  return <div className={`${max} overflow-auto -mx-3.5 px-3.5`}>{children}</div>;
}

export const TH = "p-2 text-left font-normal text-gray-500 text-xs uppercase tracking-wide";
export const TD = "p-2 align-top";
export const TR = "border-b border-white/5 last:border-0";
