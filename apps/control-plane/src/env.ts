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

  /**
   * Base URL the BROWSER uses to reach the VNC relay, e.g.
   * ws://192.168.1.50:8788. This used to be a hardcoded
   * wss://relay.it-sentinel.internal/... which resolves nowhere, so every
   * remote session failed at connect time.
   *
   * The relay must be reachable from the operator's browser AND able to
   * reach the target machine's TightVNC port. On a LAN demo that means the
   * command laptop's LAN address — a cloud host cannot route to 192.168.x.x.
   */
  RELAY_PUBLIC_URL: z.string().url().default("ws://127.0.0.1:8788"),

  /**
   * Shared secret for the /v1/voice/* routes. They are publicly reachable so
   * the ElevenLabs agent can call them, so they are not left unauthenticated.
   */
  VOICE_WEBHOOK_SECRET: z.string().min(8).optional(),

  /**
   * The PUBLISHABLE (anon) key, used for exactly one thing: verifying an
   * operator's password at /v1/auth/reauth via signInWithPassword.
   *
   * It has to be the unprivileged key. SUPABASE_SERVICE_ROLE_KEY bypasses
   * GoTrue's password check entirely, so a re-authentication built on it
   * would return "yes" to any input and the T4 gate would be decorative.
   *
   * Optional in the schema so the rest of the control plane still boots
   * without it; the reauth route refuses with 503 when it is unset rather
   * than falling back to anything, so a missing key removes T4 rather than
   * unlocking it.
   */
  SUPABASE_PUBLISHABLE_KEY: z.string().min(20).optional(),
});

export const env = EnvSchema.parse({
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  PORT: process.env.PORT,
  RELAY_PUBLIC_URL: process.env.RELAY_PUBLIC_URL,
  VOICE_WEBHOOK_SECRET: process.env.VOICE_WEBHOOK_SECRET,
  SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY,
});
