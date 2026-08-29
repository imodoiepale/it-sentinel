import Link from "next/link";
import { ui } from "../../lib/theme";
import { SentinelMark } from "./SiteHeader";

export function SiteFooter() {
  return (
    <footer className="border-t border-cloud">
      <div className={`${ui.page} flex items-center justify-between py-8`}>
        <Link href="/" className="flex items-center gap-2">
          <SentinelMark className="h-7 w-7" />
          <span className={ui.caption}>IT Sentinel</span>
        </Link>
        <Link href="/login" className={ui.navLink}>
          Sign in
        </Link>
      </div>
    </footer>
  );
}
