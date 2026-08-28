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
      },
    },
  },
  plugins: [],
} satisfies Config;
