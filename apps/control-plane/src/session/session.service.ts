import { randomUUID } from "node:crypto";
import { SessionGrant, SessionRequest } from "@it-sentinel/contracts";
import { db } from "../db.js";
import { evaluateSessionPolicy } from "../policy/policy.service.js";

/**
 * The session broker. This file is named directly in the plan as
 * security-critical: it is the ONLY place a remote or terminal session gets
 * authorized, and it NEVER returns a credential to the caller. What it
 * returns is a single-use, short-lived token the relay redeems — the relay
 * then calls decrypt_credential_for_session() itself, server-side, under
 * the service role. The browser and the operator never see a secret.
 */

const SESSION_TOKEN_TTL_SECONDS = 90;

export class SessionDeniedError extends Error {
  constructor(public readonly reason: string) {
    super(`session denied: ${reason}`);
  }
}

export async function requestSession(req: SessionRequest): Promise<SessionGrant> {
  const parsed = SessionRequest.parse(req);

  const { data: asset, error: assetError } = await db
    .from("assets")
    .select("id, site_id, credential_id, criticality")
    .eq("id", parsed.assetId)
    .single();
  if (assetError) throw assetError;

  const decision = await evaluateSessionPolicy({
    operatorId: parsed.operatorId,
    siteId: asset.site_id,
    mode: parsed.mode,
    assetCriticality: asset.criticality,
  });

  if (!decision.allowed) {
    throw new SessionDeniedError(decision.deniedReason ?? "policy denied");
  }

  if (!asset.credential_id) {
    throw new SessionDeniedError("no credential configured for this asset — nothing to connect with");
  }

  const sessionId = randomUUID();
  const { error: insertError } = await db.from("sessions").insert({
    id: sessionId,
    asset_id: parsed.assetId,
    operator_id: parsed.operatorId,
    ticket_ref: parsed.ticketRef ?? null,
    mode: parsed.mode,
    reason: parsed.reason,
  });
  if (insertError) throw insertError;

  await db.from("audit_log").insert({
    actor_id: parsed.operatorId,
    actor_kind: "operator",
    action: "session.granted",
    target_type: "asset",
    target_id: parsed.assetId,
    decision: decision.requiresConfirmation ? "confirmed" : "allowed",
    detail: { session_id: sessionId, mode: parsed.mode, ticket_ref: parsed.ticketRef ?? null },
  });

  // The single-use token binds sessionId + assetId + credentialId + expiry.
  // The relay validates and redeems it exactly once — see apps/relay.
  const singleUseToken = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TOKEN_TTL_SECONDS * 1000).toISOString();

  const { error: tokenError } = await db.from("_session_tokens" as never).insert({
    token: singleUseToken,
    session_id: sessionId,
    asset_id: parsed.assetId,
    credential_id: asset.credential_id,
    expires_at: expiresAt,
    redeemed: false,
  } as never);
  if (tokenError) throw tokenError;

  return SessionGrant.parse({
    sessionId,
    relayUrl: `wss://relay.it-sentinel.internal/session/${singleUseToken}`,
    singleUseToken,
    expiresAt,
    mode: parsed.mode,
    recorded: true,
  });
}

export async function endSession(sessionId: string, bytesTransferred: number, recordingRef?: string) {
  const { error } = await db
    .from("sessions")
    .update({ ended_at: new Date().toISOString(), bytes_transferred: bytesTransferred, recording_ref: recordingRef ?? null })
    .eq("id", sessionId);
  if (error) throw error;
}
