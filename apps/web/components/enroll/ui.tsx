import type { ReactNode } from "react";

/**
 * Presentation primitives for /enroll.
 *
 * Nothing here names a colour. Every value is one of the semantic tokens from
 * tailwind.config.ts, which resolve per theme in globals.css — so a `dark:`
 * variant would be a second colour to keep in sync and a second chance for
 * one of them to fall under the contrast floor. This page is the one screen
 * somebody outside the team lands on; it has to be right on either ground
 * without anybody remembering to check.
 */

export function Section({
  id,
  index,
  title,
  lede,
  children,
}: {
  id: string;
  /** Present only on the three steps of the primary path. The reference
   *  sections below them are deliberately unnumbered, so a conditionally
   *  rendered section can never leave a hole in the count. */
  index?: number;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-h`}>
      <div className="flex items-center gap-3">
        {index !== undefined && (
          <span
            aria-hidden
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-healthy/40 bg-healthy/10 text-xs font-semibold text-healthy-ink"
          >
            {index}
          </span>
        )}
        <h2 id={`${id}-h`} className="text-lg font-semibold tracking-tight sm:text-xl">
          {index !== undefined && <span className="sr-only">Step {index}: </span>}
          {title}
        </h2>
      </div>
      {lede && <p className="mt-2.5 max-w-2xl text-sm text-ink-soft">{lede}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-2.5 space-y-2 text-sm text-muted">{children}</div>
    </div>
  );
}

/**
 * A boxed aside. `tone` picks the colour, but the colour is never the only
 * signal: every callout carries a heading, and the "warn" tone prefixes it
 * with an sr-only "Important". Same rule StatusDot.tsx follows for status —
 * it has to read identically in monochrome and to a screen reader.
 */
export function Callout({
  tone,
  title,
  children,
}: {
  tone: "warn" | "note";
  title: string;
  children: ReactNode;
}) {
  const warn = tone === "warn";
  return (
    <div
      className={`rounded-lg border p-4 ${
        warn ? "border-warning/60 bg-warning/10" : "border-healthy/40 bg-healthy/10"
      }`}
    >
      <h3 className={`text-sm font-semibold ${warn ? "text-warning-ink" : "text-healthy-ink"}`}>
        {warn && <span className="sr-only">Important: </span>}
        {title}
      </h3>
      <div className="mt-1.5 space-y-2 text-sm text-ink-soft">{children}</div>
    </div>
  );
}

/** Inline literal — a filename, a slug, a word to type at a prompt. */
export function Mono({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em] text-ink">
      {children}
    </span>
  );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="text-healthy-ink underline underline-offset-2 transition-colors hover:no-underline"
    >
      {children}
    </a>
  );
}

/** A file the control plane serves, rendered as a download row. */
export function DownloadRow({
  href,
  title,
  file,
  badge,
  children,
}: {
  href: string;
  title: string;
  file: string;
  /** Marks the one row we actually want people to take. */
  badge?: string;
  children: ReactNode;
}) {
  const emphasised = badge !== undefined;
  return (
    <li>
      <a
        href={href}
        className={`flex flex-col gap-1.5 rounded-lg border px-4 py-3 transition-colors sm:flex-row sm:items-baseline sm:justify-between sm:gap-4 ${
          emphasised
            ? "border-healthy/50 bg-healthy/10 hover:bg-healthy/20"
            : "border-line bg-surface hover:bg-surface-2"
        }`}
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium">
            {title}
            {badge && (
              <span className="ml-2 align-middle text-[10px] font-semibold uppercase tracking-wide text-healthy-ink">
                {badge}
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-sm text-muted">{children}</span>
        </span>
        <span
          className={`shrink-0 font-mono text-xs ${emphasised ? "text-healthy-ink" : "text-muted"}`}
        >
          {file}
        </span>
      </a>
    </li>
  );
}
