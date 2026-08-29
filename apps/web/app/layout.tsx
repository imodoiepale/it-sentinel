import type { Metadata, Viewport } from "next";
import { DM_Sans } from "next/font/google";
import { colors } from "../lib/theme";
import "./globals.css";

const cosmica = DM_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-cosmica",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "IT Sentinel - Sentinel Global Command",
    template: "%s",
  },
  description: "Global IT operations command center",
};

export const viewport: Viewport = {
  themeColor: colors.paper,
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cosmica.variable}>
      <body className={cosmica.className}>{children}</body>
    </html>
  );
}
