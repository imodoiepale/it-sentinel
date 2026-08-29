import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        healthy: "#0d9488",
        warning: "#d97706",
        critical: "#dc2626",
        stale: "#6b7280",
        unknown: "#9ca3af",
        /*
          A lighter step of the healthy teal, for text and focus rings only.
          #0d9488 on #0b0f14 is ~3.1:1 — fine as a fill behind black button
          text, under the 4.5:1 floor as a foreground colour. This is the
          same hue at ~9:1 so links and labels stay legible.
        */
        "healthy-ink": "#2dd4bf",
        /*
          Same reason for the reds: #dc2626 on #0b0f14 is ~4.0:1, so it can
          fill a badge but cannot be the colour of a word someone has to read.
        */
        "critical-ink": "#f87171",
        /*
          The secondary text step. Tailwind's gray-500 is ~4.0:1 on this
          background — under the 4.5:1 floor — and gray-400 is the primary
          body colour, so there was no legible rung between them.
        */
        muted: "#8b939f",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
      keyframes: {
        /* The live-data pulse. Opacity only — no layout, no paint outside the dot. */
        breathe: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        breathe: "breathe 2.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
