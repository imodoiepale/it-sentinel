import Link from "next/link";
import { ThemeToggle } from "../ThemeToggle";
import { ButtonLink } from "../ui/Button";

/**
 * The nav is still static markup — a disclosure menu would make this a client
 * component and ship JavaScript for the very first thing painted. The theme
 * switch is the one interactive control here, and it is a leaf client
 * component, so the header itself stays a server component and only the
 * button's handler crosses the boundary.
 *
 * The section anchors are a convenience, so on small screens they collapse to
 * nothing and the three things that matter -- the mark, the theme and the
 * console -- stay.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-line-soft bg-canvas/85 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-6 px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <SentinelMark />
          <span className="text-sm font-semibold tracking-tight text-ink">IT Sentinel</span>
        </Link>

        <nav aria-label="Sections" className="hidden items-center gap-8 md:flex">
          <HeaderLink href="#fleet">Fleet</HeaderLink>
          <HeaderLink href="#capabilities">Capabilities</HeaderLink>
          <HeaderLink href="#governance">Governance</HeaderLink>
          <HeaderLink href="#loop">How it works</HeaderLink>
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <ThemeToggle />
          <Link
            href="/login"
            className="hidden text-sm text-ink-soft transition-colors hover:text-ink sm:block"
          >
            Sign in
          </Link>
          {/* The small size, not the 3rem hero pill: a 48px control inside a
              64px sticky bar leaves no air above or below it. */}
          <ButtonLink href="/console" className="ui-button-sm">
            Open the console
          </ButtonLink>
        </div>
      </div>
    </header>
  );
}

function HeaderLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="text-sm text-ink-soft transition-colors hover:text-ink">
      {children}
    </a>
  );
}

/**
 * A shield with a heartbeat trace: flat, one fault spike, flat again.
 *
 * The same drawing as public/logo-mark.svg, which is the favicon. It is
 * inlined here rather than loaded through <img> because an external SVG
 * cannot inherit the page's colours — the outline is `currentColor` so it
 * takes the surrounding text colour in either theme, and the live node is the
 * healthy token so it can never drift from the status dots it echoes.
 */
export function SentinelMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" className={`text-ink ${className}`} aria-hidden focusable="false">
      <path
        d="M24 3.5 6.5 10.2v13.1c0 10.6 7.2 20.5 17.5 23.2 10.3-2.7 17.5-12.6 17.5-23.2V10.2L24 3.5Z"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
        opacity="0.9"
      />
      <path
        d="M12.5 25.5h6.2l3.1-7.4 4.1 14.2 3-6.8h6.6"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="35.5" cy="25.5" r="2.9" className="fill-healthy-ink" />
    </svg>
  );
}
