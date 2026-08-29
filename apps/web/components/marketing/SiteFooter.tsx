import Link from "next/link";
import { SentinelMark } from "./SiteHeader";

export function SiteFooter() {
  return (
    <footer className="border-t border-line-soft">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between lg:px-8">
        <div className="flex items-center gap-2.5">
          <SentinelMark className="h-5 w-5" />
          <span className="text-sm text-ink-soft">
            IT Sentinel <span className="text-muted">/</span> Sentinel Global Command
          </span>
        </div>

        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Link href="/console" className="text-sm text-ink-soft transition-colors hover:text-ink">
            Console
          </Link>
          <Link href="/enroll" className="text-sm text-ink-soft transition-colors hover:text-ink">
            Enroll a machine
          </Link>
          <Link href="/login" className="text-sm text-ink-soft transition-colors hover:text-ink">
            Sign in
          </Link>
        </nav>
      </div>
      <div className="mx-auto w-full max-w-6xl px-6 pb-10 lg:px-8">
        <p className="text-xs text-muted">Deployed on Render. Voice by ElevenLabs.</p>
      </div>
    </footer>
  );
}
