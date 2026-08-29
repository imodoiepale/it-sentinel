import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        obsidian: "#09090b",
        graphite: "#18181b",
        slate: "#27272a",
        iron: "#3f3f46",
        steel: "#52525b",
        fog: "#71717a",
        ash: "#a1a1aa",
        mist: "#d4d4d8",
        cloud: "#ececee",
        paper: "#f4f4f5",
        snow: "#ffffff",
        ember: "#ff5a00",
        "magenta-spark": "#fe45e2",
        quiet: "#fafafa",
        healthy: "#0d9488",
        warning: "#d97706",
        critical: "#dc2626",
        stale: "#6b7280",
        unknown: "#9ca3af",
        "healthy-ink": "#2dd4bf",
        "critical-ink": "#f87171",
        muted: "#71717a",
      },
      fontFamily: {
        sans: ["var(--font-cosmica)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)"],
      },
      maxWidth: {
        page: "1200px",
      },
      spacing: {
        card: "28px",
        section: "80px",
      },
      borderRadius: {
        cards: "36px",
        icons: "40px",
        pills: "10000px",
        badges: "12px",
        inputs: "14px",
        buttons: "14px",
        breakthrough: "64px",
      },
      boxShadow: {
        subtle:
          "rgba(255, 255, 255, 0.5) 0px 0.5px 0px 0px inset, rgba(117, 123, 133, 0.4) 0px 9px 14px -5px inset, rgb(44, 46, 52) 0px 0px 0px 1.5px, rgba(0, 0, 0, 0.14) 0px 4px 6px 0px",
        "subtle-2": "rgb(228, 228, 231) 0px 1px 0px 0px inset",
        "subtle-3": "rgb(255, 255, 255) 0px 0.5px 0px 0px inset",
        "subtle-4": "rgb(255, 255, 255) 0px -0.5px 0px 0px",
        "subtle-5": "rgb(228, 228, 231) 0px -1px 0px 0px",
        md: "rgba(0, 0, 0, 0.04) 0px 4px 12px 0px",
      },
      keyframes: {
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
