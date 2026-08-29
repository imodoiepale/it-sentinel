import type { Config } from "tailwindcss";

/**
 * Every colour in this file is a CSS variable holding space-separated RGB
 * channels, resolved in app/globals.css once for dark and once for light.
 *
 * The channels are split rather than stored as `#rrggbb` so Tailwind's
 * opacity modifiers keep working: `bg-critical/10` compiles to
 * `rgb(var(--critical) / 0.1)`, which is what most of the console's tinted
 * panels are made of. A variable holding a whole hex string would break
 * every one of them.
 *
 * The point of naming them semantically is that a component writes
 * `text-muted` once and is correct in both themes. Scattering `dark:` on
 * individual elements would mean auditing two colours per element forever,
 * and the contrast floor below is the thing that would quietly rot.
 *
 * CONTRAST. This product's job is telling an operator which machine is
 * broken, so an illegible status colour is a defect, not a preference.
 * Every text token clears WCAG AA 4.5:1 against every surface it is allowed
 * to sit on, in BOTH themes, and every status dot clears the 3:1 non-text
 * floor (WCAG 1.4.11). The measured numbers are in globals.css beside the
 * values they describe.
 */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  /*
   * Class strategy, not media. Dark is the product default — this is an
   * operations console read in dim rooms — so `prefers-color-scheme` only
   * gets a vote on a first visit with no stored choice, and the decision is
   * expressed as a class on <html> that the pre-paint script in layout.tsx
   * writes. `darkMode: "media"` would hand the choice permanently to the OS
   * and make a light-mode laptop unable to see the dark product at all.
   */
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        /* ---- Grounds, darkest-to-lightest in dark and the reverse in light ---- */
        /** The page itself. */
        canvas: token("canvas"),
        /** Fixed chrome — sidebar, headers, tab strips. Distinct from canvas. */
        panel: token("panel"),
        /** A card or well sitting on canvas. */
        surface: token("surface"),
        /** Inputs, buttons, the selected row. */
        "surface-2": token("surface-2"),
        /** The hover step above surface-2. */
        "surface-3": token("surface-3"),
        /** Modal backdrop. Always used with an opacity modifier. */
        scrim: token("scrim"),

        /* ---- Hairlines ---- */
        /** Row separators and other near-invisible divisions. */
        "line-soft": token("line-soft"),
        /** The default border. */
        line: token("line"),
        /** Borders that must be seen — outline buttons, dashed empty states. */
        "line-strong": token("line-strong"),

        /* ---- Text ---- */
        /** Headings and primary values. */
        ink: token("ink"),
        /** Body copy and secondary values. */
        "ink-soft": token("ink-soft"),
        /** Labels, captions, timestamps. The lowest rung that still clears AA. */
        muted: token("muted"),
        /** Text and icons sitting on a solid status fill. */
        "on-solid": token("on-solid"),

        /*
          ---- Status ----
          Each status has a FILL (dots, meters, badges, buttons) and an INK
          (the same meaning as a word someone has to read). They are separate
          because the two jobs have different contrast floors: a fill only has
          to clear 3:1 against the ground behind it, while a word has to clear
          4.5:1 — and in dark mode the fills do not. `text-critical` on
          #0b0f14 was ~4.0:1 before this; `text-critical-ink` is 6.95:1.
        */
        healthy: token("healthy"),
        "healthy-ink": token("healthy-ink"),
        warning: token("warning"),
        "warning-ink": token("warning-ink"),
        critical: token("critical"),
        "critical-ink": token("critical-ink"),
        /** Not-reporting. Never collapsed into healthy — see StatusDot. */
        stale: token("stale"),
        "stale-ink": token("stale-ink"),
        /** Nothing has been measured yet, which is not the same as stale. */
        unknown: token("unknown"),

        /** The brand accent. Same fill/ink split, same reason — see globals.css. */
        ember: token("ember"),
        "ember-ink": token("ember-ink"),

        /** The keyboard focus ring, so it is one value app-wide. */
        focus: token("focus"),
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
