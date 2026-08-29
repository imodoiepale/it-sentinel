export interface Branch {
  slug: string;
  name: string;
  region: string | null;
  criticality: string | null;
}

/**
 * Shown before the branch list arrives, and kept if it never does.
 *
 * The same seven slugs are a constant in the control plane (they have to
 * match the ones `install-sentinel-agent.ps1` hard-accepts, and both trace
 * back to `packages/db/seed/003_bootstrap_demo.sql`), so a cold start on a
 * free dyno — fifty seconds is normal — should not leave somebody standing at
 * a laptop looking at an empty picker.
 */
export const FALLBACK_BRANCHES: Branch[] = [
  { slug: "nairobi-hq", name: "Nairobi HQ", region: "Africa", criticality: "critical" },
  { slug: "lagos", name: "Lagos", region: "Africa", criticality: "standard" },
  { slug: "dubai", name: "Dubai", region: "Middle East", criticality: "standard" },
  { slug: "london", name: "London", region: "Europe", criticality: "standard" },
  { slug: "singapore", name: "Singapore", region: "APAC", criticality: "standard" },
  { slug: "sao-paulo", name: "Sao Paulo", region: "LATAM", criticality: "standard" },
  { slug: "new-york", name: "New York", region: "Americas", criticality: "critical" },
];
