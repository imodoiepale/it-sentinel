import { z } from "zod";
import { ActionTier } from "@it-sentinel/contracts";

/**
 * Every tool the Sentinel Agent can call, declaring its OWN tier
 * statically — the model never gets to claim a tier, and the executor
 * never infers one from what the model says it wants to do. Per the plan's
 * build order step 15: only T0-T2 read-only tools exist in this registry
 * right now. T3+ (restart a service, clear a queue) is a deliberate,
 * separate follow-on, added only after this file's adversarial suite has
 * run clean for a while in practice — not something this session adds
 * speculatively.
 */

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  tier: ActionTier;
  description: string;
  argsSchema: z.ZodType<TArgs>;
  /** Table(s) this tool is allowed to touch — the executor cross-checks this against the deny list independently of what the tool implementation actually does. */
  allowedTables: string[];
}

const AssetHealthArgs = z.object({ assetId: z.string().uuid() });
const FleetStatusArgs = z.object({ siteSlug: z.string().optional() });
const RecurrenceArgs = z.object({ checkType: z.string(), assetId: z.string().uuid(), faultClass: z.string().optional() });
const IncidentsArgs = z.object({ siteSlug: z.string().optional(), status: z.enum(["open", "in_progress", "resolved", "closed"]).optional() });
const CheckHistoryArgs = z.object({ assetId: z.string().uuid(), checkType: z.string().optional(), limit: z.number().int().positive().max(50).default(10) });

export const TOOL_REGISTRY: ToolDefinition<any>[] = [
  {
    name: "get_asset_health",
    tier: "T0",
    description: "Current health snapshot for one machine — network, RAM, disk, printer, email, Enquest, endpoint security.",
    argsSchema: AssetHealthArgs,
    allowedTables: ["asset_health"],
  },
  {
    name: "get_fleet_status",
    tier: "T0",
    description: "Fleet-wide or single-branch health summary.",
    argsSchema: FleetStatusArgs,
    allowedTables: ["sites", "assets", "asset_health"],
  },
  {
    name: "get_recurrence",
    tier: "T0",
    description: "How many times this fault has happened before, and what fix worked last time.",
    argsSchema: RecurrenceArgs,
    allowedTables: ["incidents"],
  },
  {
    name: "list_incidents",
    tier: "T0",
    description: "Open or historical incidents, optionally filtered by branch and status.",
    argsSchema: IncidentsArgs,
    allowedTables: ["incidents"],
  },
  {
    name: "get_check_history",
    tier: "T1",
    description: "Recent diagnostic check results for one machine (printer chain, Enquest sync, network score, ...).",
    argsSchema: CheckHistoryArgs,
    allowedTables: ["checks"],
  },
];

export function findTool(name: string): ToolDefinition<any> | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name);
}
