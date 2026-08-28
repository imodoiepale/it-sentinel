import { RoleTierCeiling, T6_DENY_PATTERNS, OperatorRole, ActionTier } from "@it-sentinel/contracts";
import { findTool } from "../tools/registry.js";

/**
 * The Sentinel Agent's own policy guard — independent of, but aligned
 * with, apps/agent-node/src/exec's deny-list and tier logic. Two separate
 * enforcement points for the same rules is deliberate defense in depth:
 * this guards what the AGENT can even ask a database for; agent-node's
 * executor separately guards what gets run on a MACHINE. Neither trusts
 * the other to have done its job.
 */

const T6_TABLE_DENYLIST = ["credentials", "_session_tokens", "audit_log", "vault.secrets", "vault.decrypted_secrets"];

export interface GuardContext {
  operatorRole: OperatorRole;
  operatorSiteIds: Set<string>;
}

export type GuardDecision =
  | { allowed: true }
  | { allowed: false; reason: string; denyPattern?: string };

/**
 * Called before ANY tool call reaches its implementation. Order matters,
 * same as agent-node's executor: unknown-tool refusal, then table
 * allowlist / T6 check, then tier-vs-role, then (by the caller, since it
 * needs the resolved site) scope check.
 */
export function evaluateToolCall(toolName: string, ctx: GuardContext): GuardDecision {
  const tool = findTool(toolName);
  if (!tool) {
    return { allowed: false, reason: `unknown tool: ${toolName}` };
  }

  for (const table of tool.allowedTables) {
    if (T6_TABLE_DENYLIST.some((denied) => table === denied || table.startsWith(`${denied}.`))) {
      return {
        allowed: false,
        reason: `tool ${toolName} declares access to a T6-denied table: ${table}`,
        denyPattern: "read_vault_secret",
      };
    }
  }

  const ceiling = RoleTierCeiling[ctx.operatorRole];
  const tierOrder: ActionTier[] = ["T0", "T1", "T2", "T3", "T4", "T5", "T6"];
  if (tierOrder.indexOf(tool.tier) > tierOrder.indexOf(ceiling)) {
    return { allowed: false, reason: `operator role ${ctx.operatorRole} is capped at ${ceiling}, tool ${toolName} requires ${tool.tier}` };
  }

  return { allowed: true };
}

/**
 * Scans free-text the model might pass as an argument (rare for these
 * typed T0-T2 tools, but future write-tool arguments will carry more raw
 * text) against the same T6_DENY_PATTERNS constant the executor uses —
 * one shared source of truth for what's categorically forbidden.
 */
export function scanArgsForDenyPatterns(args: unknown): string | null {
  const text = JSON.stringify(args).toLowerCase();
  const SIMPLE_MATCHERS: Record<string, RegExp> = {
    read_vault_secret: /vault\.decrypted_secrets|decrypt_credential_for_session/,
    delete_audit_log: /delete\s+from\s+.*audit_log|clear-eventlog/,
    view_cctv_video: /camera.*(stream|video|footage)/,
  };
  for (const [pattern, regex] of Object.entries(SIMPLE_MATCHERS)) {
    if (regex.test(text) && T6_DENY_PATTERNS.includes(pattern as (typeof T6_DENY_PATTERNS)[number])) {
      return pattern;
    }
  }
  return null;
}
