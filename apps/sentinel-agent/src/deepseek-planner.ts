import type { Planner } from "./planner.js";
import type { ToolCall } from "./executor.js";
import { buildToolSpecs } from "./tools/openai-schema.js";

/**
 * A real client against DeepSeek's actual documented tool-calling
 * contract — researched from api-docs.deepseek.com/guides/function_calling
 * and /guides/tool_calls before writing a line of this file, plus vLLM's
 * DeepSeek tool-call-parser docs to confirm self-hosted open weights
 * (served via vLLM/Ollama with --tool-call-parser deepseek_v3 or
 * deepseek_v31) normalize to the same OpenAI-compatible JSON shape as
 * DeepSeek's hosted API. This is genuinely their format, not a guess:
 *
 *   POST {baseUrl}/chat/completions
 *   { model, messages: [{role, content}], tools: [...], tool_choice: "auto" }
 *   -> choices[0].message.tool_calls[0] = { function: { name, arguments } }
 *      where `arguments` is a JSON *string*, not an object.
 *
 * `baseUrl` defaults to nothing — this class requires DEEPSEEK_BASE_URL to
 * be set explicitly (either DeepSeek's hosted https://api.deepseek.com, or
 * a self-hosted vLLM/Ollama endpoint), and is never wired up as the
 * harness's default. Swapping StubPlanner for this is a one-line change
 * in main.ts, made deliberately, not automatically — see the plan's
 * build-order discipline in docs/10-sentinel-agent.md: the harness runs
 * clean with a stub before any real model traffic touches it.
 *
 * What this file does NOT do, on purpose: it never trusts the model's
 * output as anything other than a proposed ToolCall. The executor and
 * guard downstream (src/executor.ts, src/policy/guard.ts) re-validate
 * everything regardless of what DeepSeek returned — a compromised or
 * hallucinating model can propose whatever it wants; it still can't reach
 * a tool that doesn't exist or a site outside the operator's scope.
 */

export interface DeepSeekPlannerOptions {
  baseUrl: string;
  apiKey: string;
  model?: string;
  systemPrompt?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODEL = "deepseek-chat";

const DEFAULT_SYSTEM_PROMPT =
  "You are the Sentinel Agent, a read-only diagnostic assistant for a multi-branch IT fleet. " +
  "You can only see what the tools available to you return — never invent data, IPs, hostnames, or " +
  "incident history you were not given by a tool result. If a question needs information no available " +
  "tool can provide, say so plainly rather than guessing. You have no ability to change anything; every " +
  "tool you can call is read-only.";

export class DeepSeekPlanner implements Planner {
  private readonly toolSpecs = buildToolSpecs();

  constructor(private readonly options: DeepSeekPlannerOptions) {}

  async plan(question: string): Promise<ToolCall | { clarify: string }> {
    const doFetch = this.options.fetchImpl ?? fetch;

    const response = await doFetch(`${this.options.baseUrl}/chat/completions`, {
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
      throw new Error(`DeepSeek request failed: ${response.status} ${body}`.trim());
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: { function: { name: string; arguments: string } }[] } }[];
    };

    const message = payload.choices?.[0]?.message;
    const toolCall = message?.tool_calls?.[0];

    // vLLM's DeepSeek parsers have a documented failure mode where raw
    // DSML markup leaks into `content` instead of producing a structured
    // tool_calls entry, especially with thinking mode enabled. Rather than
    // trying to regex-recover a tool call out of leaked text ourselves —
    // which would mean trusting unparsed model output — any response
    // without a clean, parseable tool_calls entry is treated as "no tool
    // call," falling through to the clarification path.
    if (!toolCall) {
      return { clarify: message?.content?.trim() || "I couldn't determine which tool to use for that — could you rephrase?" };
    }

    let args: unknown;
    try {
      // DeepSeek's own docs warn: "Generated tool arguments may not always
      // be valid JSON and should be validated before your application
      // calls the function." This catch is that validation's first line —
      // the executor's Zod schema check is the second and authoritative one.
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      return { clarify: `The model proposed calling ${toolCall.function.name} but with malformed arguments — please rephrase your question.` };
    }

    return { name: toolCall.function.name, args };
  }
}
