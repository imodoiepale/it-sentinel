import { createClient } from "@supabase/supabase-js";

/**
 * The browser-side client, scoped to the publishable key — this key is
 * meant to be public (it's what RLS exists to constrain), unlike the
 * service-role key the control plane holds server-side. An operator's
 * session here can only ever see what their site_access rows and role
 * permit, enforced at the database, not by this file.
 */
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
);

export const CONTROL_PLANE_URL = process.env.NEXT_PUBLIC_CONTROL_PLANE_URL ?? "http://localhost:8787";

/**
 * The Sentinel Agent's /v1/ask endpoint. Separate origin from the control
 * plane on purpose — the agent holds no service-role credential and reads
 * only through the operator's own JWT, so it is deployed and scaled apart
 * from anything that can act on the fleet.
 */
export const SENTINEL_AGENT_URL = process.env.NEXT_PUBLIC_SENTINEL_AGENT_URL ?? "http://localhost:8789";
