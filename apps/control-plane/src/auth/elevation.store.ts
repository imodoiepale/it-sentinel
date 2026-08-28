import { createHash, randomBytes } from "node:crypto";

/**
 * Short-lived, single-use elevation grants — the thing a successful password
 * re-authentication mints and the only thing that unlocks T4.
 *
 * Design notes that matter more than the code:
 *
 *  - Only a SHA-256 of the token is kept. A dump of this process's heap, or
 *    of whatever replaces this Map later, yields nothing replayable. Lookup
 *    is by that hash, so the raw secret is never compared byte-by-byte
 *    against a stored value and there is no comparison to time.
 *  - Single use is enforced by marking the grant consumed and KEEPING the
 *    record until it expires, so a replay is reported as "already used"
 *    rather than "unrecognised". A grant that vanished on use would be
 *    indistinguishable from one that never existed, which makes a replay
 *    attack look identical to a typo in the audit trail.
 *  - Expiry is evaluated lazily on read. A sweeper on a timer would be a
 *    second place the rule lives, and a rule that can be wrong in two places
 *    eventually is.
 *
 * Deliberate limitation: this is process-local. One control-plane instance
 * is what the demo runs, and single-use semantics across instances need a
 * shared store (a Postgres table with a partial unique index on the unspent
 * rows) rather than sticky sessions, which would fail open under a restart.
 */

/** Five minutes, and it is a ceiling rather than a default — see mintElevationToken. */
const ELEVATION_TTL_MS = 5 * 60 * 1000;

interface ElevationGrant {
  operatorId: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

const grants = new Map<string, ElevationGrant>();

function fingerprint(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

/**
 * A non-secret handle for a token, safe to write into a CommandRequest, the
 * pgmq envelope, command_runs and audit_log. Truncated so it is obviously
 * not the token itself, and derived one-way so possessing it does not let
 * anyone reconstruct one.
 */
export function elevationReference(token: string): string {
  return fingerprint(token).slice(0, 32);
}

export function mintElevationToken(operatorId: string, ttlMs: number = ELEVATION_TTL_MS): {
  token: string;
  expiresAt: string;
} {
  pruneExpired();
  const now = Date.now();
  // min(), not the caller's value: a caller can ask for a shorter window but
  // never a longer one, so no future call site can quietly turn a five-minute
  // elevation into a standing one.
  const expiresAt = now + Math.min(ttlMs, ELEVATION_TTL_MS);
  const token = randomBytes(32).toString("base64url");
  grants.set(fingerprint(token), { operatorId, issuedAt: now, expiresAt, consumedAt: null });
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

export type ElevationCheck = { ok: true } | { ok: false; reason: string };

/**
 * Validate and spend a token in one step. There is no separate "check" call
 * on purpose: a check-then-use pair is a TOCTOU window, and two concurrent
 * dispatches presenting the same token would both pass the check.
 */
export function consumeElevationToken(operatorId: string, token: string | undefined): ElevationCheck {
  if (!token) return { ok: false, reason: "no elevation token was presented" };

  const grant = grants.get(fingerprint(token));
  if (!grant) return { ok: false, reason: "elevation token is not recognised" };
  if (grant.operatorId !== operatorId) {
    return { ok: false, reason: "elevation token was issued to a different operator" };
  }
  if (grant.consumedAt !== null) return { ok: false, reason: "elevation token has already been used" };
  if (Date.now() >= grant.expiresAt) return { ok: false, reason: "elevation token has expired" };

  grant.consumedAt = Date.now();
  return { ok: true };
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, grant] of grants) {
    if (now >= grant.expiresAt) grants.delete(key);
  }
}

/** Test-only. Never called from src/ — an elevation store that can be emptied on request is not one. */
export function __resetElevationStore(): void {
  grants.clear();
}

export { ELEVATION_TTL_MS };
