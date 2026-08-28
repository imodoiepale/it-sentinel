import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { db } from "../db.js";
import { env } from "../env.js";
import { mintElevationToken } from "./elevation.store.js";

/**
 * Operator password re-authentication — the gate in front of T4.
 *
 * The console session that reaches this route is already authenticated; that
 * is exactly why this exists. A logged-in tab left open on an unlocked
 * workstation is the realistic threat against a console that can run
 * arbitrary PowerShell on a POS till, and only a fresh password proves the
 * human is still the one at the keyboard.
 *
 * The password is read from the body, handed straight to GoTrue, and
 * dropped. It is never logged (Fastify's request logger records method, url
 * and status, never bodies), never echoed in a response, and never written
 * to audit_log — the audit row records that a re-auth was attempted and how
 * it ended, which is the part an investigator needs.
 */

/**
 * email + password, with operatorId optional and used only as a cross-check.
 *
 * The token is bound to the uuid GoTrue returns for whoever actually signed
 * in, NOT to the operatorId the client claimed. Trusting the claimed id would
 * let anyone with their own valid password mint an elevation bound to a
 * colleague with a higher role ceiling. Supplying operatorId is still useful
 * — it catches a console whose session drifted out of sync with the account
 * being typed into the dialog — so a mismatch is refused, as a plain 401.
 */
const ReauthRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(1024),
  operatorId: z.string().uuid().optional(),
});

/**
 * Constant cost on every failure. It is not a rate limiter, but it turns an
 * online guessing loop from thousands of attempts a second into single
 * digits, and it is applied identically to "no such account", "wrong
 * password" and "id mismatch" so the response time cannot be used to tell
 * them apart either.
 */
const FAILURE_DELAY_MS = 700;

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

interface FailureRecord {
  count: number;
  firstFailureAt: number;
  lockedUntil: number;
}

const failures = new Map<string, FailureRecord>();

/**
 * Keyed on the submitted email rather than the source IP. A NAT'd branch puts
 * a whole site behind one address, so per-IP lockout would let one operator's
 * fat fingers lock out the shift; per-identity lockout targets the account
 * actually under attack. It is also case-normalised, since GoTrue treats
 * addresses case-insensitively and a case-varying loop would otherwise get a
 * fresh budget on every attempt.
 */
function throttleKey(email: string): string {
  return email.trim().toLowerCase();
}

function lockoutRemainingMs(key: string): number {
  const record = failures.get(key);
  if (!record) return 0;
  const remaining = record.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

function recordFailure(key: string): void {
  const now = Date.now();
  const record = failures.get(key);
  if (!record || now - record.firstFailureAt > LOCKOUT_MS) {
    failures.set(key, { count: 1, firstFailureAt: now, lockedUntil: 0 });
    return;
  }
  record.count += 1;
  if (record.count >= MAX_FAILURES) record.lockedUntil = now + LOCKOUT_MS;
}

function clearFailures(key: string): void {
  failures.delete(key);
}

/**
 * A fresh client per attempt. signInWithPassword parks the resulting session
 * on the client instance, so a shared one would hold the last successful
 * operator's tokens in memory between requests and interleave them under
 * concurrency. Constructing one is a few object allocations — no connection,
 * no handshake — so there is nothing to pool.
 */
function newPasswordVerificationClient(publishableKey: string) {
  return createClient(env.SUPABASE_URL, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function auditReauth(
  app: FastifyInstance,
  operatorId: string | null,
  decision: "allowed" | "denied",
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await db.from("audit_log").insert({
      actor_id: operatorId,
      actor_kind: "operator",
      action: "operator.reauth",
      target_type: "operator",
      target_id: operatorId,
      tier: "T4",
      decision,
      detail,
    });
  } catch (err) {
    // A failed audit write must not decide the request: on the deny path it
    // would turn a 401 into a 500 and hand an attacker a way to tell a real
    // account from a fake one, and on the allow path the elevation has
    // already been earned. It is logged loudly instead.
    app.log.error({ err }, "failed to write operator.reauth audit row");
  }
}

export function registerAuthRoutes(app: FastifyInstance) {
  /**
   * Mints a five-minute, single-use elevation token on success. Failure is
   * always a bare 401 with one fixed message: distinguishing "unknown
   * account" from "wrong password" here would turn this route into an
   * operator-directory oracle for anyone who can reach the API.
   */
  app.post("/v1/auth/reauth", async (request, reply) => {
    const parsed = ReauthRequest.safeParse(request.body);
    if (!parsed.success) {
      // No issue list in the response, unlike /v1/heartbeat: the body carries
      // a password, and Zod echoes offending values in some issue shapes.
      await delay(FAILURE_DELAY_MS);
      return reply.code(400).send({ error: "invalid_reauth_request" });
    }

    const { email, password, operatorId: claimedOperatorId } = parsed.data;
    const key = throttleKey(email);

    const lockedFor = lockoutRemainingMs(key);
    if (lockedFor > 0) {
      return reply
        .code(429)
        .send({ error: "too_many_attempts", retryAfterSeconds: Math.ceil(lockedFor / 1000) });
    }

    const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;
    if (!publishableKey) {
      // Fail closed. Without the unprivileged key there is no way to check a
      // password, and the one alternative — the service-role key — would
      // authenticate everybody.
      app.log.error("SUPABASE_PUBLISHABLE_KEY is not set; T4 elevation is unavailable");
      return reply.code(503).send({ error: "reauth_unavailable" });
    }

    const client = newPasswordVerificationClient(publishableKey);
    const { data, error } = await client.auth.signInWithPassword({ email, password });

    // Everything below this line treats `password` as gone.
    const signedInOperatorId = data?.user?.id ?? null;

    if (signedInOperatorId) {
      // Drop the session this check just created. Scope is local on purpose:
      // "global" would revoke every refresh token the operator holds and log
      // them out of the console they are sitting in, so verifying a password
      // would end the session it was meant to elevate.
      await client.auth.signOut({ scope: "local" }).catch(() => {});
    }

    if (error || !signedInOperatorId) {
      recordFailure(key);
      await auditReauth(app, claimedOperatorId ?? null, "denied", { reason: "invalid_credentials" });
      await delay(FAILURE_DELAY_MS);
      return reply.code(401).send({ error: "reauth_failed" });
    }

    if (claimedOperatorId && claimedOperatorId !== signedInOperatorId) {
      recordFailure(key);
      await auditReauth(app, signedInOperatorId, "denied", { reason: "operator_id_mismatch" });
      await delay(FAILURE_DELAY_MS);
      return reply.code(401).send({ error: "reauth_failed" });
    }

    clearFailures(key);
    const { token, expiresAt } = mintElevationToken(signedInOperatorId);
    await auditReauth(app, signedInOperatorId, "allowed", { expires_at: expiresAt });

    return reply.code(201).send({ operatorId: signedInOperatorId, elevationToken: token, expiresAt });
  });
}
