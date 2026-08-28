import { db } from "../db.js";

/**
 * Thin wrapper over the database-enforced credential vault. Note what this
 * file does NOT do: it never logs the returned secret, never writes it to
 * a response body sent to a browser, and the only caller (the relay, in
 * session-redemption flow) uses it in-process and discards it after the
 * RFB handshake completes. The real enforcement is the GRANT on
 * decrypt_credential_for_session — this wrapper is convenience, not the
 * security boundary.
 */

export async function storeCredential(args: {
  label: string;
  credentialType: "vnc" | "windows_admin" | "winrm" | "other";
  secret: string;
  siteId?: string;
  assetId?: string;
  rotationPolicyDays?: number;
}): Promise<string> {
  const { data, error } = await db.rpc("store_credential", {
    p_label: args.label,
    p_credential_type: args.credentialType,
    p_secret: args.secret,
    p_site_id: args.siteId ?? null,
    p_asset_id: args.assetId ?? null,
    p_rotation_policy_days: args.rotationPolicyDays ?? 90,
  });
  if (error) throw error;
  return data as string;
}

/** Called only by the relay's session-redemption path, never by any operator-facing route. */
export async function decryptCredentialForSession(credentialId: string, sessionId: string): Promise<string> {
  const { data, error } = await db.rpc("decrypt_credential_for_session", {
    p_credential_id: credentialId,
    p_session_id: sessionId,
  });
  if (error) throw error;
  return data as string;
}
