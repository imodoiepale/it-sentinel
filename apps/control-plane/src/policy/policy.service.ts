import { ActionTier, OperatorRole, PolicyDecision, RoleTierCeiling, T6_DENY_PATTERNS } from "@it-sentinel/contracts";
import { db } from "../db.js";

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
 * Evaluate a command tier request against role ceiling and the T6 deny
 * list. Blast-radius and dual-approval enforcement for T5 lives in the
 * orchestrator, which has visibility into how many assets a dispatch
 * targets; this function only knows about one asset at a time.
 */
export async function evaluateCommandPolicy(args: {
  operatorId: string;
  siteId: string;
  tier: ActionTier;
  denyPatternHit?: string;
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

  return PolicyDecision.parse({
    allowed: true,
    tier: args.tier,
    requiresConfirmation: args.tier === "T3",
    requiresApprover: args.tier === "T4",
    requiresDualApproval: args.tier === "T5",
  });
}
