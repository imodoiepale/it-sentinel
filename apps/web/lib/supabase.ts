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
