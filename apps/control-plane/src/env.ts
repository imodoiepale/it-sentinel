import { z } from "zod";

/**
 * Service-role credentials live here, server-side only, sourced from process
 * env. Never bundled to a browser, never handed to the Sentinel Agent — the
 * decrypt_credential_for_session RPC is grant-restricted to service_role at
 * the database level regardless of what this process does, but we also
 * never construct a client with anon/authenticated scope for privileged ops.
 */
const EnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  PORT: z.coerce.number().int().positive().default(8787),
});

export const env = EnvSchema.parse({
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  PORT: process.env.PORT,
});
