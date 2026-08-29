import type { Metadata, Viewport } from "next";
import "./globals.css";

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
};

/*
 * The page ground is set here as well as in globals.css so the browser paints
 * the right colour in the chrome around the viewport (address bar, overscroll)
 * instead of flashing white before the stylesheet lands.
 */
export const viewport: Viewport = {
  themeColor: "#0b0f14",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
