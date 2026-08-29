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

/*
 * `SENTINEL_AGENT_URL` was removed with the Ask Sentinel box. It pointed at
 * apps/sentinel-agent's /v1/ask, but deployment sets
 * NEXT_PUBLIC_SENTINEL_AGENT_URL to the control-plane origin, which has no
 * such route, and the agent itself is not deployed — so every call 404'd.
 * Voice questions now go to the ElevenLabs agent (components/VoiceAgentWidget).
 * Restore this only alongside a /v1/ask that genuinely answers.
 */
