import type { ToolCall } from "./executor.js";

/**
 * A deliberate stand-in for DeepSeek, per the plan's build-order discipline
 * for step 15: "the harness, executor and T6 deny list [get built] with a
 * stub model first; assert every boundary; only then attach DeepSeek."
 *
 * This planner does no real reasoning — it pattern-matches a handful of
 * fixed phrasings to a ToolCall, purely so the executor/guard pipeline
 * above it can be exercised and adversarially tested end-to-end without a
 * GPU or a model endpoint. Swapping this for a real vLLM/Ollama-served
 * DeepSeek client is a drop-in replacement of this one file's interface —
 * everything downstream (guard, executor, audit) is unaffected, which is
 * the point of the seam.
 */
export interface Planner {
  plan(question: string): Promise<ToolCall | { clarify: string }>;
}

export class StubPlanner implements Planner {
  async plan(question: string): Promise<ToolCall | { clarify: string }> {
    const q = question.toLowerCase();

    const assetIdMatch = q.match(/asset ([0-9a-f-]{36})/);
    const siteSlugMatch = q.match(/(?:branch|site) ([a-z0-9-]+)/);

    if (q.includes("health") && assetIdMatch) {
      return { name: "get_asset_health", args: { assetId: assetIdMatch[1] } };
    }
    if (q.includes("fleet") || q.includes("status of all")) {
      return { name: "get_fleet_status", args: siteSlugMatch ? { siteSlug: siteSlugMatch[1] } : {} };
    }
    if (q.includes("open incident") || q.includes("open tickets")) {
      return { name: "list_incidents", args: { status: "open", ...(siteSlugMatch ? { siteSlug: siteSlugMatch[1] } : {}) } };
    }
    if (q.includes("check history") && assetIdMatch) {
      return { name: "get_check_history", args: { assetId: assetIdMatch[1] } };
    }

    return { clarify: "I can check asset health, fleet status, open incidents, or check history — which one, and for which asset or branch?" };
  }
}
