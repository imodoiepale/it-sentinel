import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

/**
 * The one service-role client in the process. Every module imports this
 * rather than constructing its own client, so there is exactly one place
 * service-role credentials are held in memory.
 */
export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
