import { ButtonLink } from "../ui/Button";

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
    <section id={id} className={`border-t border-line-soft ${className}`}>
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
      <h2 className="mt-3 text-pretty text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
        {title}
      </h2>
      {lede && <p className="mt-4 text-pretty text-base leading-7 text-ink-soft">{lede}</p>}
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
  /*
    The hover lift is the only motion on the marketing page. It exists because
    in light mode a card is a near-white panel on a white ground and the border
    is doing all the work; a border that darkens on hover confirms the card is
    a discrete object rather than a seam in the background.
  */
  return (
    <div
      className={`rounded-xl border border-line bg-surface p-6 transition-colors hover:border-line-strong ${className}`}
    >
      {children}
    </div>
  );
}

/*
 * Both CTAs are now thin wrappers over the shared ButtonLink rather than
 * bespoke class strings. Every existing call site keeps working, and the
 * pill geometry, the press feedback and the focus ring are defined once in
 * globals.css instead of being restated per link — which is how the two
 * drifted apart in the first place.
 */
export function PrimaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <ButtonLink href={href} variant="primary">
      {children}
    </ButtonLink>
  );
}

export function SecondaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <ButtonLink href={href} variant="secondary">
      {children}
    </ButtonLink>
  );
}

/**
 * A live indicator. The dot is decorative; the word beside it carries the
 * meaning, following StatusDot's rule that colour is never the only signal.
 */
export function LivePip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs font-medium text-ink-soft">
      <span className="relative flex h-2 w-2" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-breathe rounded-full bg-healthy-ink" />
      </span>
      {label}
    </span>
  );
}
