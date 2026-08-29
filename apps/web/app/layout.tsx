import type { Metadata, Viewport } from "next";
import "./globals.css";
import { THEME_BOOTSTRAP } from "../components/ThemeToggle";

export const metadata: Metadata = {
  /*
   * `default` rather than a bare string so the landing page can set its own
   * title without every console screen having to restate the product name.
   */
  title: {
    default: "IT Sentinel - Sentinel Global Command",
    template: "%s",
  },
  description: "Global IT operations command center",
  icons: { icon: "/logo-mark.svg" },
};

/*
 * The browser paints its own chrome (address bar, overscroll gutter) from
 * themeColor before any CSS lands, so it has to be told both grounds. There
 * is no class-aware form of this meta tag — it only understands media
 * queries — so a user who has chosen light on a dark-set OS gets a dark
 * address bar around a light page. That is a strip of browser chrome, not
 * the page, and the alternative is a white flash in the overscroll gutter of
 * the dark default, which is the case that actually matters here.
 *
 * `colorScheme` is deliberately NOT set: globals.css sets the CSS
 * `color-scheme` property per theme instead, so native controls (scrollbars,
 * date pickers, autofill) follow the class rather than being pinned to dark.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0f14" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * `className="dark"` is the server's answer, and it is the product
     * default: with JavaScript off, or before the script below runs, this is
     * a dark app.
     *
     * `suppressHydrationWarning` is required because the script may have
     * changed that class to `light` between the HTML being parsed and React
     * hydrating. Only this one element differs, and React does not reconcile
     * root attributes it did not itself change, so the class the script wrote
     * survives hydration.
     */
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/*
          Why an inline, blocking script rather than a useEffect.

          The App Router streams a server-rendered shell. A `useEffect` that
          toggles the theme class necessarily runs AFTER React has hydrated,
          which is after the browser has already painted the server's answer —
          so a light-mode user sees a full dark frame first, and sees it again
          on every client-side navigation that remounts the effect. That is
          the white-flash bug in reverse and it is unfixable from inside React.

          This script is in <head>, has no `async`/`defer` and no `src`, so
          the HTML parser stops and executes it before it has parsed <body> —
          before there is anything to paint. By the time the first pixel is
          drawn the class is already final, so there is no wrong-theme frame
          to flash. And because it mutates <html>, which persists across
          client-side navigation, it never needs to run again.

          `dangerouslySetInnerHTML` is the only way to emit a raw inline
          script from JSX. The content is a compile-time constant with no
          interpolation of anything user-supplied.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
