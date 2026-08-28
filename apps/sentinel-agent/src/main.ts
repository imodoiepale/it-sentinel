import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { StubPlanner } from "./planner.js";
import { DeepSeekPlanner } from "./deepseek-planner.js";
import { OpenAiPlanner } from "./openai-planner.js";
import type { Planner } from "./planner.js";
import { executeToolCall } from "./executor.js";
import type { GuardContext } from "./policy/guard.js";
import type { OperatorRole } from "@it-sentinel/contracts";

/**
 * Sentinel Agent's HTTP face — /v1/ask, POST { question, operatorJwt }.
 * Which planner sits behind it is chosen from the environment at startup
 * (see `planner` below) and logged, so which model — if any — is answering
 * is verifiable from the process's first line of output rather than
 * inferred from behaviour.
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
 * Planner selection is environment-driven, and StubPlanner is the floor,
 * not a failure: with no model configured the harness still answers a
 * useful subset of questions with zero network dependency. That matters
 * because the console now calls this endpoint live — losing connectivity
 * should degrade the answers, not hang the UI.
 *
 * OPENAI_API_KEY wins over DEEPSEEK_BASE_URL when both are present simply
 * because a hosted key is the more deliberate act of configuration; both
 * remain explicit opt-ins, never inferred defaults.
 */
/**
 * OpenAI keys start with "sk-". Checking the shape before selecting the
 * planner is not pedantry: OPENAI_API_KEY is a common variable name and gets
 * set to unrelated values by other tooling — on the machine this was built
 * on it already held a 140-character JWT. Selecting on mere presence then
 * picks a planner that 401s on every question, and because the failure only
 * appears at ask time it looks like the agent is broken rather than
 * misconfigured. Falling through to the next planner with a loud warning
 * keeps the system answering.
 */
function looksLikeOpenAiKey(key: string): boolean {
  return key.startsWith("sk-");
}

function selectPlanner(): { planner: Planner; description: string } {
  const openAiKey = process.env.OPENAI_API_KEY;
  if (openAiKey && !looksLikeOpenAiKey(openAiKey)) {
    console.warn(
      "[sentinel-agent] OPENAI_API_KEY is set but does not look like an OpenAI key (expected a value starting with \"sk-\"). " +
        "Ignoring it and falling through to the next planner — clear or correct the variable to use OpenAI.",
    );
  }
  if (openAiKey && looksLikeOpenAiKey(openAiKey)) {
    const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    return {
      planner: new OpenAiPlanner({ apiKey: openAiKey, model: process.env.OPENAI_MODEL }),
      description: `OpenAiPlanner (model ${model})`,
    };
  }
  if (process.env.DEEPSEEK_BASE_URL) {
    return {
      planner: new DeepSeekPlanner({
        baseUrl: process.env.DEEPSEEK_BASE_URL,
        apiKey: process.env.DEEPSEEK_API_KEY ?? "",
        model: process.env.DEEPSEEK_MODEL,
      }),
      description: `DeepSeekPlanner against ${process.env.DEEPSEEK_BASE_URL}`,
    };
  }
  return { planner: new StubPlanner(), description: "StubPlanner (no model configured — offline fallback)" };
}

const { planner, description: plannerDescription } = selectPlanner();
console.log(`[sentinel-agent] planner: ${plannerDescription}`);

/**
 * The console is served from a different origin than :8789, so without
 * these headers the browser drops every answer before JS ever sees it —
 * a failure that looks identical to the agent hanging. Kept permissive on
 * origin deliberately: the only credential this endpoint accepts is the
 * operator JWT in the request *body*, and no cookies are involved, so a
 * wildcard origin grants a hostile page nothing it couldn't already do
 * with a JWT it would have to steal first.
 */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

const JSON_HEADERS = { "content-type": "application/json", ...CORS_HEADERS };

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
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS).end();
    return;
  }

  if (req.method !== "POST" || req.url !== "/v1/ask") {
    res.writeHead(404, CORS_HEADERS).end();
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const { question, operatorJwt } = JSON.parse(body) as { question: string; operatorJwt: string };
      if (!question || !operatorJwt) {
        res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "question and operatorJwt are required" }));
        return;
      }

      const db = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${operatorJwt}` } },
      });

      const ctx = await resolveGuardContext(db);
      if (!ctx) {
        res.writeHead(403, JSON_HEADERS).end(JSON.stringify({ error: "operator has no site_access grants" }));
        return;
      }

      const plan = await planner.plan(question);
      if ("clarify" in plan) {
        res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ clarify: plan.clarify }));
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

      res.writeHead(200, JSON_HEADERS).end(JSON.stringify(result));
    } catch (err) {
      console.error("[sentinel-agent] /v1/ask error:", err);
      res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: "internal_error" }));
    }
  });
});

server.listen(PORT, () => console.log(`[sentinel-agent] listening on :${PORT}`));
