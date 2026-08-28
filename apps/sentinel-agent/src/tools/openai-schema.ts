import { zodToJsonSchema } from "zod-to-json-schema";
import { TOOL_REGISTRY, type ToolDefinition } from "./registry.js";

/**
 * Converts the tool registry into the OpenAI-compatible `tools` array shape
 * that both DeepSeek's hosted API and vLLM/Ollama-served DeepSeek open
 * weights expect (confirmed against api-docs.deepseek.com/guides/
 * tool_calls and vLLM's --tool-call-parser deepseek_v3/deepseek_v31
 * implementations — self-hosted DeepSeek's native DSML tool-call markup is
 * parsed by vLLM's server into exactly this JSON shape, so the client side
 * never has to speak DSML itself).
 *
 * Generated directly from each tool's `argsSchema` — the same Zod schema
 * the executor validates against — so the schema advertised to the model
 * and the schema actually enforced can never drift apart.
 *
 * DeepSeek's documented strict-mode constraints (all properties required,
 * additionalProperties: false, no minLength/maxLength/minItems/maxItems)
 * are applied here rather than left to chance, since a schema the model
 * can't validate in strict mode degrades to best-effort parsing instead.
 */

export interface OpenAiToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict: true;
  };
}

function toStrictJsonSchema(tool: ToolDefinition<any>): Record<string, unknown> {
  const schema = zodToJsonSchema(tool.argsSchema, { target: "openApi3" }) as Record<string, unknown>;
  // zod-to-json-schema doesn't set additionalProperties:false by default,
  // and DeepSeek's strict mode requires it explicitly.
  return { ...schema, additionalProperties: false };
}

export function buildToolSpecs(): OpenAiToolSpec[] {
  return TOOL_REGISTRY.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toStrictJsonSchema(tool),
      strict: true,
    },
  }));
}
