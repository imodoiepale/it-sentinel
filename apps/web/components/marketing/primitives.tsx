import Link from "next/link";

/**
 * Shared shapes for the landing page. These exist so the sections cannot
 * drift apart on spacing and type scale — the console next door is a dense
 * operations screen, and the only thing keeping the marketing page feeling
 * like the same product is that its rhythm is defined in one place.
 */

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-medium uppercase tracking-[0.18em] text-healthy-ink">{children}</p>
  );
}

export function Section({
  id,
  children,
  className = "",
}: {
  id?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`border-t border-white/[0.07] ${className}`}>
      <div className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-24 lg:px-8">{children}</div>
    </section>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
}) {
  return (
    <div className="max-w-2xl">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-3 text-pretty text-3xl font-semibold tracking-tight text-white sm:text-4xl">
        {title}
      </h2>
      {lede && <p className="mt-4 text-pretty text-base leading-7 text-gray-400">{lede}</p>}
    </div>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-white/[0.09] bg-white/[0.02] p-6 ${className}`}
    >
      {children}
    </div>
  );
}

export function PrimaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center justify-center rounded-md bg-healthy px-5 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-healthy-ink"
    >
      {children}
    </Link>
  );
}

export function SecondaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center justify-center rounded-md border border-white/15 px-5 py-2.5 text-sm font-semibold text-gray-200 transition-colors hover:border-white/30 hover:bg-white/[0.04] hover:text-white"
    >
      {children}
    </Link>
  );
}

/**
 * A live indicator. The dot is decorative; the word beside it carries the
 * meaning, following StatusDot's rule that colour is never the only signal.
 */
export function LivePip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs font-medium text-gray-400">
      <span className="relative flex h-2 w-2" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-breathe rounded-full bg-healthy-ink" />
      </span>
      {label}
    </span>
  );
}
