import Link from "next/link";

/**
 * Deliberately has no interactive menu: a disclosure button would make this
 * a client component and ship JavaScript for the very first thing painted.
 * The section anchors are a convenience, so on small screens they collapse
 * to nothing and the two things that matter -- the mark and the console --
 * stay.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.07] bg-[#0b0f14]/85 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-6 px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <SentinelMark />
          <span className="text-sm font-semibold tracking-tight text-white">IT Sentinel</span>
        </Link>

        <nav aria-label="Sections" className="hidden items-center gap-8 md:flex">
          <HeaderLink href="#fleet">Fleet</HeaderLink>
          <HeaderLink href="#capabilities">Capabilities</HeaderLink>
          <HeaderLink href="#governance">Governance</HeaderLink>
          <HeaderLink href="#loop">How it works</HeaderLink>
        </nav>

        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="hidden text-sm text-gray-400 transition-colors hover:text-white sm:block"
          >
            Sign in
          </Link>
          <Link
            href="/console"
            className="rounded-md bg-healthy px-3.5 py-2 text-sm font-semibold text-black transition-colors hover:bg-healthy-ink"
          >
            Open the console
          </Link>
        </div>
      </div>
    </header>
  );
}

function HeaderLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="text-sm text-gray-400 transition-colors hover:text-white">
      {children}
    </a>
  );
}

/* Concentric sweep: a watched perimeter with one machine at the centre. */
export function SentinelMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden focusable="false">
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" className="fill-none stroke-healthy" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="6" className="fill-none stroke-healthy-ink" strokeWidth="1.25" opacity="0.5" />
      <circle cx="12" cy="12" r="2.25" className="fill-healthy-ink" />
    </svg>
  );
}
