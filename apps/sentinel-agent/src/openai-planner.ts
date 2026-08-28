import type { Planner } from "./planner.js";
import type { ToolCall } from "./executor.js";
import { buildToolSpecs } from "./tools/openai-schema.js";

/**
 * The OpenAI-hosted counterpart to DeepSeekPlanner. Both speak the same
 * chat-completions tool-calling wire format, which is exactly why
 * deepseek-planner.ts, tools/openai-schema.ts and this file share a
 * contract instead of each inventing one:
 *
 *   POST {baseUrl}/chat/completions
 *   { model, messages: [{role, content}], tools: [...], tool_choice: "auto" }
 *   -> choices[0].message.tool_calls[0] = { function: { name, arguments } }
 *      where `arguments` is a JSON *string*, not an object.
 *
 * `baseUrl` defaults to OpenAI's public API but stays overridable, since
 * an Azure OpenAI deployment or a local gateway serves the identical
 * route under a different origin and there is no reason to fork a class
 * over a hostname.
 *
 * Same standing rule as the DeepSeek client: nothing this file returns is
 * trusted as more than a *proposed* ToolCall. src/executor.ts and
 * src/policy/guard.ts re-validate tool name, tier, deny patterns, schema
 * and site scope regardless of what the model asked for, and the Supabase
 * client the executor runs against is built from the operator's own JWT —
 * so a hallucinating or prompt-injected model still cannot reach a tool
 * that doesn't exist or a branch the operator can't see.
 */

export interface OpenAiPlannerOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  systemPrompt?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

const DEFAULT_SYSTEM_PROMPT =
  "You are the Sentinel Agent, a read-only diagnostic assistant for a multi-branch IT fleet. " +
  "You can only see what the tools available to you return — never invent data, IPs, hostnames, or " +
  "incident history you were not given by a tool result. If a question needs information no available " +
  "tool can provide, say so plainly rather than guessing. You have no ability to change anything; every " +
  "tool you can call is read-only.";

export class OpenAiPlanner implements Planner {
  /**
   * Built from the same registry Zod schemas the executor validates
   * against, via buildToolSpecs() — but published to OpenAI with strict
   * mode OFF. OpenAI's structured-outputs strict mode requires every key
   * in `properties` to also appear in `required`, and several registry
   * tools take genuinely optional filters (siteSlug, status, checkType).
   * Forcing those into `required` would make the model invent a branch or
   * a status filter it was never asked for — a far worse failure than
   * best-effort argument parsing, which the executor's Zod check catches
   * anyway. DeepSeek tolerates strict:true with partial `required`, hence
   * the difference between the two clients here.
   */
  private readonly toolSpecs = buildToolSpecs().map((spec) => ({
    ...spec,
    function: { ...spec.function, strict: false },
  }));

  constructor(private readonly options: OpenAiPlannerOptions) {}

  async plan(question: string): Promise<ToolCall | { clarify: string }> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const baseUrl = this.options.baseUrl ?? DEFAULT_BASE_URL;

    const response = await doFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.options.model ?? DEFAULT_MODEL,
        messages: [
          { role: "system", content: this.options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
          { role: "user", content: question },
        ],
        tools: this.toolSpecs,
        tool_choice: "auto",
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenAI request failed: ${response.status} ${body}`.trim());
    }

    // A 200 carrying HTML from a misconfigured proxy is a real deployment
    // failure mode; treat unparseable bodies as "no plan" rather than
    // letting a SyntaxError escape into main.ts's 500 handler.
    let payload: {
      choices?: { message?: { content?: string | null; tool_calls?: { function: { name: string; arguments: string } }[] } }[];
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      return { clarify: "The model returned a response I couldn't read — please try again." };
    }

    const message = payload.choices?.[0]?.message;
    const toolCall = message?.tool_calls?.[0];

    if (!toolCall) {
      return { clarify: message?.content?.trim() || "I couldn't determine which tool to use for that — could you rephrase?" };
    }

    let args: unknown;
    try {
      // Tool arguments arrive as a model-generated JSON string; OpenAI
      // makes no guarantee it parses when strict mode is off. This is the
      // first validation line, the executor's Zod check the authoritative one.
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      return { clarify: `The model proposed calling ${toolCall.function.name} but with malformed arguments — please rephrase your question.` };
    }

    return { name: toolCall.function.name, args };
  }
}
