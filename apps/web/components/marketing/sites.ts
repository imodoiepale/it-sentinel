export interface PublicSite {
  id: string;
  name: string;
  slug: string;
  region: string;
  criticality: string;
}

const SITES_ENDPOINT = `${
  process.env.NEXT_PUBLIC_CONTROL_PLANE_URL ?? "https://it-sentinel-control-plane.onrender.com"
}/v1/sites`;

/**
 * Deliberately not a "use client" module: the landing page calls this during
 * SSR *and* the branch list calls it again from the browser as a fallback.
 * Every export of a "use client" file becomes a client reference when a
 * server component imports it, so the shared helper has to live outside one.
 *
 * GET /v1/sites is unauthenticated by design — it returns the branch roster
 * and nothing about any machine — which is what makes it safe to put on a
 * public page. `primary_ip` is in that payload and is dropped rather than
 * rendered: RFC1918 space is harmless, but a marketing page is not where an
 * estate publishes its addressing.
 *
 * Never throws. A landing page that 500s because a sidebar list timed out
 * is a worse failure than a landing page missing one list.
 */
export async function fetchSites(timeoutMs: number): Promise<PublicSite[] | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(SITES_ENDPOINT, {
      signal: abort.signal,
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { sites?: PublicSite[] };
    return Array.isArray(body.sites) && body.sites.length > 0 ? body.sites : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
