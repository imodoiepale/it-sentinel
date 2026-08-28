import { SupabaseClient } from "@supabase/supabase-js";
import { OperatorRole } from "@it-sentinel/contracts";
import { findTool } from "./tools/registry.js";
import { evaluateToolCall, scanArgsForDenyPatterns, GuardContext } from "./policy/guard.js";

/**
 * THE executor — the only place a tool call the model emits becomes an
 * actual database query. Everything upstream of this (the planner, the
 * model, the conversation) only ever produces a ToolCall request; nothing
 * upstream can execute anything directly. Per the plan: "the model never
 * executes anything. It emits a tool call; the harness validates,
 * classifies and authorises it; a separate executor performs it."
 *
 * Order of checks, mirroring agent-node's executor.ts:
 *   1. Unknown tool / T6 table / role-tier check (policy/guard.ts)
 *   2. Deny-pattern scan of the arguments themselves
 *   3. Site-scope check — an asset or branch outside the operator's
 *      site_access is refused before any query runs, never after
 *   4. Execute using the operator-scoped Supabase client (never a
 *      service-role client) so RLS is a second, independent backstop
 *      even if this file had a bug
 */

export interface ToolCall {
  name: string;
  args: unknown;
}

export interface ToolResult {
  toolName: string;
  outcome: "success" | "refused";
  data?: unknown;
  refusalReason?: string;
}

export interface AgentDeps {
  db: SupabaseClient;
  auditRefusal: (toolName: string, args: unknown, reason: string) => Promise<void>;
  auditSuccess: (toolName: string, args: unknown) => Promise<void>;
  resolveSiteIdForAsset: (assetId: string) => Promise<string | null>;
  resolveSiteIdForSlug: (siteSlug: string) => Promise<string | null>;
}

export async function executeToolCall(call: ToolCall, ctx: GuardContext, deps: AgentDeps): Promise<ToolResult> {
  const decision = evaluateToolCall(call.name, ctx);
  if (!decision.allowed) {
    await deps.auditRefusal(call.name, call.args, decision.reason);
    return { toolName: call.name, outcome: "refused", refusalReason: decision.reason };
  }

  const denyHit = scanArgsForDenyPatterns(call.args);
  if (denyHit) {
    const reason = `arguments match T6 deny pattern: ${denyHit}`;
    await deps.auditRefusal(call.name, call.args, reason);
    return { toolName: call.name, outcome: "refused", refusalReason: reason };
  }

  const tool = findTool(call.name)!;
  const parsedArgs = tool.argsSchema.safeParse(call.args);
  if (!parsedArgs.success) {
    const reason = `arguments failed schema validation: ${JSON.stringify(parsedArgs.error.issues)}`;
    await deps.auditRefusal(call.name, call.args, reason);
    return { toolName: call.name, outcome: "refused", refusalReason: reason };
  }

  // Site scope: an asset or branch outside this operator's site_access
  // grants is refused here, before any query executes — same rule as
  // "out-of-scope site rejected at every tier" from the plan.
  const args = parsedArgs.data as Record<string, unknown>;
  if (typeof args.assetId === "string") {
    const siteId = await deps.resolveSiteIdForAsset(args.assetId);
    if (!siteId || !ctx.operatorSiteIds.has(siteId)) {
      const reason = `asset ${args.assetId} is outside this operator's site scope`;
      await deps.auditRefusal(call.name, call.args, reason);
      return { toolName: call.name, outcome: "refused", refusalReason: reason };
    }
  }
  if (typeof args.siteSlug === "string") {
    const siteId = await deps.resolveSiteIdForSlug(args.siteSlug);
    if (!siteId || !ctx.operatorSiteIds.has(siteId)) {
      const reason = `site ${args.siteSlug} is outside this operator's site scope`;
      await deps.auditRefusal(call.name, call.args, reason);
      return { toolName: call.name, outcome: "refused", refusalReason: reason };
    }
  }

  const data = await runTool(call.name, args, deps.db);
  await deps.auditSuccess(call.name, call.args);
  return { toolName: call.name, outcome: "success", data };
}

/**
 * The actual read implementation per tool. Deliberately thin — every
 * query goes through the operator-scoped `deps.db` client, so even a bug
 * here that widened a filter still can't cross RLS's own boundary.
 */
async function runTool(name: string, args: Record<string, unknown>, db: SupabaseClient): Promise<unknown> {
  switch (name) {
    case "get_asset_health": {
      const { data, error } = await db.from("asset_health").select("*").eq("asset_id", args.assetId).single();
      if (error) throw error;
      return data;
    }
    case "get_fleet_status": {
      let query = db.from("assets").select("id, hostname, site_id, sites(name, slug), asset_health(status, online)");
      if (args.siteSlug) {
        const { data: site } = await db.from("sites").select("id").eq("slug", args.siteSlug).single();
        if (site) query = query.eq("site_id", site.id);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data;
    }
    case "get_recurrence": {
      const fingerprint = args.faultClass
        ? `${args.checkType}:${args.assetId}:${args.faultClass}`
        : `${args.checkType}:${args.assetId}`;
      const { data, error } = await db
        .from("incidents")
        .select("ticket_ref, title, resolution_summary, resolution_success, opened_at")
        .eq("fingerprint", fingerprint)
        .order("opened_at", { ascending: false })
        .limit(5);
      if (error) throw error;
      return data;
    }
    case "list_incidents": {
      let query = db.from("incidents").select("*").order("opened_at", { ascending: false }).limit(20);
      if (args.status) query = query.eq("status", args.status as string);
      if (args.siteSlug) {
        const { data: site } = await db.from("sites").select("id").eq("slug", args.siteSlug).single();
        if (site) query = query.eq("site_id", site.id);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data;
    }
    case "get_check_history": {
      let query = db
        .from("checks")
        .select("*")
        .eq("asset_id", args.assetId)
        .order("checked_at", { ascending: false })
        .limit((args.limit as number) ?? 10);
      if (args.checkType) query = query.eq("check_type", args.checkType as string);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    }
    default:
      throw new Error(`no implementation for tool ${name}`);
  }
}
