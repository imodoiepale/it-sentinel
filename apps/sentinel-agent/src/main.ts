import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { StubPlanner } from "./planner.js";
import { DeepSeekPlanner } from "./deepseek-planner.js";
import type { Planner } from "./planner.js";
import { executeToolCall } from "./executor.js";
import type { GuardContext } from "./policy/guard.js";
import type { OperatorRole } from "@it-sentinel/contracts";

/**
 * Sentinel Agent's HTTP face — /v1/ask, POST { question, operatorJwt }.
 * Deliberately built against the StubPlanner (see planner.ts) until this
 * harness has run adversarially clean for a while; swapping to a real
 * DeepSeek client is a one-line change to `planner` below.
 *
 * Critically: the operator's own JWT is what builds the Supabase client
 * here, NOT a service-role key. Even if the executor or guard had a bug,
 * RLS on every table this agent touches is a second, independent
 * boundary — the agent's database access is never wider than the
 * operator's own.
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY!;
const PORT = Number(process.env.SENTINEL_AGENT_PORT ?? 8789);

/**
 * StubPlanner is the default deliberately — see docs/10-sentinel-agent.md
 * for the build-order reasoning. DEEPSEEK_BASE_URL is an explicit opt-in,
 * never inferred or defaulted, so a deployment doesn't accidentally start
 * sending real questions to a real model just because a key happened to
 * be present in the environment somewhere.
 */
const planner: Planner = process.env.DEEPSEEK_BASE_URL
  ? new DeepSeekPlanner({
      baseUrl: process.env.DEEPSEEK_BASE_URL,
      apiKey: process.env.DEEPSEEK_API_KEY ?? "",
      model: process.env.DEEPSEEK_MODEL,
    })
  : new StubPlanner();

if (process.env.DEEPSEEK_BASE_URL) {
  console.log(`[sentinel-agent] using DeepSeekPlanner against ${process.env.DEEPSEEK_BASE_URL}`);
} else {
  console.log("[sentinel-agent] DEEPSEEK_BASE_URL not set — using StubPlanner (no real model attached)");
}

async function resolveGuardContext(db: any): Promise<GuardContext | null> {
  const { data: raw, error } = await db.from("site_access").select("site_id, role");
  if (error || !raw || raw.length === 0) return null;
  const data = raw as { site_id: string; role: string }[];
  // An operator can hold different roles on different sites; the guard
  // uses the highest-privilege role they hold anywhere as their ceiling
  // for tool selection — the per-call site-scope check in executor.ts is
  // what actually constrains which sites any given answer can touch.
  const roleOrder: OperatorRole[] = ["auditor", "l1_support", "l2_support", "security_admin", "l3_sysadmin", "it_manager"];
  const highestRole = data.reduce<OperatorRole>((best, row) => {
    const role = row.role as OperatorRole;
    return roleOrder.indexOf(role) > roleOrder.indexOf(best) ? role : best;
  }, "auditor");

  return {
    operatorRole: highestRole,
    operatorSiteIds: new Set(data.map((r) => r.site_id as string)),
  };
}

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/ask") {
    res.writeHead(404).end();
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const { question, operatorJwt } = JSON.parse(body) as { question: string; operatorJwt: string };
      if (!question || !operatorJwt) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "question and operatorJwt are required" }));
        return;
      }

      const db = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${operatorJwt}` } },
      });

      const ctx = await resolveGuardContext(db);
      if (!ctx) {
        res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "operator has no site_access grants" }));
        return;
      }

      const plan = await planner.plan(question);
      if ("clarify" in plan) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ clarify: plan.clarify }));
        return;
      }

      const result = await executeToolCall(plan, ctx, {
        db: db as any,
        auditRefusal: async (toolName, args, reason) => {
          await db.from("audit_log").insert({
            actor_kind: "sentinel_agent",
            action: `tool.${toolName}`,
            decision: "denied",
            detail: { args, reason },
          });
        },
        auditSuccess: async (toolName, args) => {
          await db.from("audit_log").insert({
            actor_kind: "sentinel_agent",
            action: `tool.${toolName}`,
            decision: "allowed",
            detail: { args },
          });
        },
        resolveSiteIdForAsset: async (assetId) => {
          const { data } = await db.from("assets").select("site_id").eq("id", assetId).maybeSingle();
          return data?.site_id ?? null;
        },
        resolveSiteIdForSlug: async (slug) => {
          const { data } = await db.from("sites").select("id").eq("slug", slug).maybeSingle();
          return data?.id ?? null;
        },
      });

      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (err) {
      console.error("[sentinel-agent] /v1/ask error:", err);
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "internal_error" }));
    }
  });
});

server.listen(PORT, () => console.log(`[sentinel-agent] listening on :${PORT}`));
