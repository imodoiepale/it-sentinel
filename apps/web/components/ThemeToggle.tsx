"use client";

/**
 * The theme switch, and the script that decides the theme before first paint.
 *
 * Both live in this file so the storage key and the default rule are written
 * down once. A toggle that persists under one key while the bootstrap reads
 * another is a bug that only shows up as a flash on the second page load,
 * which is a miserable thing to debug.
 */

/** Chosen over `theme` to avoid colliding with anything else on the origin. */
const STORAGE_KEY = "sentinel-theme";

/**
 * Runs synchronously in <head>, before <body> is parsed. See layout.tsx for
 * why it cannot be a React effect.
 *
 * The default is dark, and the rule that produces it is deliberately not
 * `matches("(prefers-color-scheme: dark)")`. That query is false both for an
 * OS set to light AND for one that has expressed no preference at all, which
 * would hand every indifferent visitor a light operations console. Asking the
 * inverse question — has the OS explicitly asked for light? — puts "no
 * preference" on the dark side, where this product's default belongs.
 *
 * Everything is wrapped in try/catch because `localStorage` throws outright
 * in some privacy modes, and a theme preference is not worth a blank page.
 */
export const THEME_BOOTSTRAP = `(function(){try{var s=localStorage.getItem(${JSON.stringify(
  STORAGE_KEY,
)});var d=s?s!=="light":!window.matchMedia("(prefers-color-scheme: light)").matches;document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

/**
 * The button renders identically on the server whichever theme is active:
 * both icons and both labels are always in the markup, and `dark:` variants
 * decide which pair is displayed. Deriving the visible state from React state
 * instead would mean the server could not know it, which is either a
 * hydration mismatch or a one-frame flash of the wrong icon — the same class
 * of bug the bootstrap script exists to avoid.
 *
 * `hidden` is display:none, so the inactive sr-only label is out of the
 * accessibility tree too and a screen reader hears exactly one instruction.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  function toggle() {
    const root = document.documentElement;
    const nowDark = !root.classList.contains("dark");
    root.classList.toggle("dark", nowDark);
    try {
      localStorage.setItem(STORAGE_KEY, nowDark ? "dark" : "light");
    } catch {
      // Private mode with storage disabled. The class still flipped, so the
      // switch works for this session; it just will not be remembered.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title="Switch between the light and dark theme"
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line text-muted transition-colors hover:border-line-strong hover:text-ink ${className}`}
    >
      {/* Sun when it is dark, because the button offers the other theme. */}
      <SunIcon className="hidden h-4 w-4 dark:block" />
      <MoonIcon className="h-4 w-4 dark:hidden" />
      <span className="sr-only hidden dark:inline">Switch to the light theme</span>
      <span className="sr-only dark:hidden">Switch to the dark theme</span>
    </button>
  );
}

function SunIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" aria-hidden focusable="false">
      <circle cx="10" cy="10" r="3.6" stroke="currentColor" strokeWidth="1.5" />
      <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M10 1.6v2M10 16.4v2M1.6 10h2M16.4 10h2M4.1 4.1l1.4 1.4M14.5 14.5l1.4 1.4M15.9 4.1l-1.4 1.4M5.5 14.5l-1.4 1.4" />
      </g>
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none" aria-hidden focusable="false">
      <path
        d="M16.5 12.4A7 7 0 0 1 7.6 3.5a7 7 0 1 0 8.9 8.9Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
