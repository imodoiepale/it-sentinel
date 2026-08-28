import { ActionTier, OperatorRole, PolicyDecision, RoleTierCeiling, T6_DENY_PATTERNS } from "@it-sentinel/contracts";
import { db } from "../db.js";
import { currentElevationToken } from "../auth/elevation.context.js";
import { consumeElevationToken } from "../auth/elevation.store.js";

/**
 * The tier engine. This is advisory scaffolding for the control plane's own
 * API surface — the *authoritative* enforcement for elevated execution
 * lives in apps/agent-node/src/exec/executor.ts, which cannot be bypassed
 * by calling this service directly, because the agent independently
 * re-validates every CommandRequest against its own compiled deny list
 * before running anything. Defense in depth: this stops a bad request at
 * the API boundary; the executor stops it again at the point of execution.
 */

const TIER_ORDER: ActionTier[] = ["T0", "T1", "T2", "T3", "T4", "T5", "T6"];

function tierAtOrBelow(tier: ActionTier, ceiling: ActionTier): boolean {
  return TIER_ORDER.indexOf(tier) <= TIER_ORDER.indexOf(ceiling);
}

export async function getOperatorRoleForSite(operatorId: string, siteId: string): Promise<OperatorRole | null> {
  const { data, error } = await db
    .from("site_access")
    .select("role")
    .eq("operator_id", operatorId)
    .eq("site_id", siteId)
    .maybeSingle();
  if (error) throw error;
  return (data?.role as OperatorRole) ?? null;
}

export async function evaluateSessionPolicy(args: {
  operatorId: string;
  siteId: string;
  mode: "view" | "control" | "terminal";
  assetCriticality: string;
}): Promise<PolicyDecision> {
  const role = await getOperatorRoleForSite(args.operatorId, args.siteId);
  if (!role) {
    return PolicyDecision.parse({
      allowed: false,
      tier: "T3",
      requiresConfirmation: false,
      requiresApprover: false,
      requiresDualApproval: false,
      deniedReason: "operator has no access grant for this site",
    });
  }

  // Terminal sessions carry elevated (LocalSystem-backed) capability, so
  // they're gated at T3 minimum regardless of view/control.
  const tier: ActionTier = args.mode === "terminal" ? "T3" : "T0";
  const ceiling = RoleTierCeiling[role];

  if (!tierAtOrBelow(tier, ceiling)) {
    return PolicyDecision.parse({
      allowed: false,
      tier,
      requiresConfirmation: false,
      requiresApprover: false,
      requiresDualApproval: false,
      deniedReason: `role ${role} is capped at ${ceiling}, session requires ${tier}`,
    });
  }

  return PolicyDecision.parse({
    allowed: true,
    tier,
    requiresConfirmation: tier !== "T0",
    requiresApprover: false,
    requiresDualApproval: false,
  });
}

/**
 * Evaluate a command tier request against role ceiling, the T6 deny list,
 * and — at T4 only — a live password re-authentication. Blast-radius and
 * dual-approval enforcement for T5 lives in the orchestrator, which has
 * visibility into how many assets a dispatch targets; this function only
 * knows about one asset at a time.
 *
 * elevationToken is optional and normally left unset: the dispatch path
 * carries it in request-scoped context (see auth/elevation.context.ts) so
 * that a caller which knows nothing about elevation cannot reach T4 by
 * omission. The explicit parameter exists for direct callers and tests.
 */
export async function evaluateCommandPolicy(args: {
  operatorId: string;
  siteId: string;
  tier: ActionTier;
  denyPatternHit?: string;
  elevationToken?: string;
}): Promise<PolicyDecision> {
  if (args.denyPatternHit && T6_DENY_PATTERNS.includes(args.denyPatternHit as (typeof T6_DENY_PATTERNS)[number])) {
    return PolicyDecision.parse({
      allowed: false,
      tier: "T6",
      requiresConfirmation: false,
      requiresApprover: false,
      requiresDualApproval: false,
      deniedReason: `matches T6 deny pattern: ${args.denyPatternHit}`,
    });
  }

  const role = await getOperatorRoleForSite(args.operatorId, args.siteId);
  if (!role) {
    return PolicyDecision.parse({
      allowed: false,
      tier: args.tier,
      requiresConfirmation: false,
      requiresApprover: false,
      requiresDualApproval: false,
      deniedReason: "operator has no access grant for this site",
    });
  }

  const ceiling = RoleTierCeiling[role];
  if (!tierAtOrBelow(args.tier, ceiling)) {
    return PolicyDecision.parse({
      allowed: false,
      tier: args.tier,
      requiresConfirmation: false,
      requiresApprover: false,
      requiresDualApproval: false,
      deniedReason: `role ${role} is capped at ${ceiling}, command requires ${args.tier}`,
    });
  }

  /**
   * T4 is the Operator Console tier — arbitrary PowerShell, no cmdlet
   * allowlist — so holding a role that reaches T4 is necessary and not
   * sufficient. The operator must also have re-entered their password within
   * the last five minutes and still hold the unspent single-use token that
   * minted (see auth/reauth.routes.ts).
   *
   * Checked AFTER the ceiling check, for two reasons: an l1_support request
   * should be refused for the honest reason (its ceiling) rather than for a
   * missing token it could never use anyway, and a token must not be burned
   * by a request that was going to be denied regardless — an operator who
   * fat-fingers the wrong machine should not have to re-enter their password
   * to try again.
   */
  if (args.tier === "T4") {
    const check = consumeElevationToken(args.operatorId, args.elevationToken ?? currentElevationToken());
    if (!check.ok) {
      return PolicyDecision.parse({
        allowed: false,
        tier: args.tier,
        requiresConfirmation: false,
        requiresApprover: false,
        requiresDualApproval: false,
        deniedReason: `T4 requires password re-authentication: ${check.reason}`,
      });
    }
  }

  return PolicyDecision.parse({
    allowed: true,
    tier: args.tier,
    // T4 is confirmed in the console the same way T3 is, on top of the
    // password prompt — the read-back is what stops the wrong command going
    // to a re-authenticated session, which re-auth itself says nothing about.
    requiresConfirmation: args.tier === "T3" || args.tier === "T4",
    requiresApprover: args.tier === "T4",
    requiresDualApproval: args.tier === "T5",
  });
}
