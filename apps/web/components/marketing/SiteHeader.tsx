import Link from "next/link";
import { ui } from "../../lib/theme";
import { ButtonLink } from "../ui/Button";

export function SiteHeader() {
  return (
    <header className={ui.header}>
      <div className={`${ui.page} flex h-[72px] items-center justify-between gap-6`}>
        <Link href="/" className="flex items-center gap-2">
          <SentinelMark />
          <span className="text-[14px] font-medium text-obsidian">IT Sentinel</span>
        </Link>

        <nav aria-label="Sections" className="hidden items-center gap-8 md:flex">
          <HeaderLink href="#capabilities">Work</HeaderLink>
          <HeaderLink href="#fleet">Fleet</HeaderLink>
          <HeaderLink href="#governance">Guards</HeaderLink>
        </nav>

        <div className="flex items-center gap-3">
          <Link href="/login" className={`hidden sm:block ${ui.navLink}`}>
            Sign in
          </Link>
          <ButtonLink href="/console" variant="primary">
            Open the console
          </ButtonLink>
        </div>
      </div>
    </header>
  );
}

function HeaderLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className={ui.navLink}>
      {children}
    </a>
  );
}

export function SentinelMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden focusable="false">
      <rect x="1" y="1" width="30" height="30" rx="12" className="fill-none stroke-cloud" strokeWidth="1" />
      <circle cx="16" cy="16" r="7" className="fill-none stroke-obsidian" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="2.5" className="fill-obsidian" />
    </svg>
  );
}
