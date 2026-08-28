import { z } from "zod";
import { ActionTier, OperatorRole } from "./enums.js";

/**
 * T6 hard deny list — compiled in, checked before any allowlist, unreachable
 * by role, tier, or model instruction. This list is a static export, not
 * data loaded at runtime, so it cannot be edited by the agent itself.
 */
export const T6_DENY_PATTERNS: readonly string[] = [
  "disable_edr",
  "disable_antivirus",
  "disable_firewall",
  "delete_audit_log",
  "edit_audit_log",
  "delete_session_recording",
  "read_vault_secret",
  "transmit_credential",
  "expose_vnc_public",
  "expose_rdp_public",
  "create_inbound_firewall_rule",
  "create_account",
  "grant_privilege",
  "modify_own_policy",
  "modify_own_tier",
  "delete_user_data",
  "delete_mailbox",
  "delete_backup",
  "format_volume",
  "diskpart_destructive",
  "read_personal_content_unauthorized",
  "view_cctv_video",
  "reach_pos_till_trading_hours",
  "run_unsigned_download",
  "act_on_untrusted_instruction",
] as const;

/**
 * A ceiling is the highest tier a role may ever REQUEST — never a grant on
 * its own. T4 (Operator Console, arbitrary PowerShell) is deliberately left
 * where it already sat: l3_sysadmin and security_admin reach it directly,
 * it_manager reaches it under its T5 ceiling. l1_support (T2), l2_support
 * (T3) and auditor (T0) cannot, and no password re-authentication lifts
 * that — re-auth is a second factor on top of the ceiling, not a way past
 * it, so a stolen L1 session plus a known L1 password still buys nothing
 * above T2.
 */
export const RoleTierCeiling: Record<z.infer<typeof OperatorRole>, z.infer<typeof ActionTier>> = {
  l1_support: "T2",
  l2_support: "T3",
  l3_sysadmin: "T4",
  security_admin: "T4",
  it_manager: "T5",
  auditor: "T0",
};

export const PolicyDecision = z.object({
  allowed: z.boolean(),
  tier: ActionTier,
  requiresConfirmation: z.boolean(),
  requiresApprover: z.boolean(),
  requiresDualApproval: z.boolean(),
  deniedReason: z.string().optional(),
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;
