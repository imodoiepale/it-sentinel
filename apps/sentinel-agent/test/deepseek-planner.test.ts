import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { DeepSeekPlanner } from "../src/deepseek-planner.js";

/**
 * Tests the harness's DeepSeek integration WITHOUT a live model or API
 * key — exactly the "cage before model" discipline applied to the
 * planner's own plumbing. What's proven here: the request matches
 * DeepSeek's documented contract, and the response parser handles both
 * the happy path and the specific failure modes their own docs and vLLM's
 * issue tracker call out (malformed argument JSON, no tool_calls at all,
 * leaked/absent structured output under thinking mode).
 */

function mockFetch(responseBody: unknown, status = 200) {
  return vi.fn(async (url: string, init: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(responseBody),
    json: async () => responseBody,
  })) as unknown as typeof fetch;
}

describe("DeepSeekPlanner: request shape matches the documented contract", () => {
  it("POSTs to {baseUrl}/chat/completions with tools, tool_choice, and the question as a user message", async () => {
    const fetchImpl = mockFetch({ choices: [{ message: { tool_calls: [{ function: { name: "get_fleet_status", arguments: "{}" } } ] } }] });
    const planner = new DeepSeekPlanner({ baseUrl: "https://api.deepseek.com/v1", apiKey: "test-key", fetchImpl });

    await planner.plan("what's the fleet status?");

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer test-key");

    const body = JSON.parse(init.body);
    expect(body.model).toBe("deepseek-chat");
    expect(body.tool_choice).toBe("auto");
    expect(body.messages).toEqual([
      { role: "system", content: expect.stringContaining("read-only") },
      { role: "user", content: "what's the fleet status?" },
    ]);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.tools[0]).toMatchObject({ type: "function", function: { strict: true } });
  });

  it("advertises every registry tool with a strict JSON Schema (additionalProperties: false)", async () => {
    const fetchImpl = mockFetch({ choices: [{ message: { content: "no tool needed" } }] });
    const planner = new DeepSeekPlanner({ baseUrl: "https://x", apiKey: "k", fetchImpl });
    await planner.plan("anything");

    const body = JSON.parse((fetchImpl as any).mock.calls[0][1].body);
    const toolNames = body.tools.map((t: any) => t.function.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(["get_asset_health", "get_fleet_status", "get_recurrence", "list_incidents", "get_check_history"]),
    );
    for (const tool of body.tools) {
      expect(tool.function.parameters.additionalProperties).toBe(false);
    }
  });
});

describe("DeepSeekPlanner: response parsing", () => {
  it("parses a valid tool_calls response into a ToolCall with args as a real object", async () => {
    const assetId = randomUUID();
    const fetchImpl = mockFetch({
      choices: [{ message: { tool_calls: [{ function: { name: "get_asset_health", arguments: JSON.stringify({ assetId }) } }] } }],
    });
    const planner = new DeepSeekPlanner({ baseUrl: "https://x", apiKey: "k", fetchImpl });

    const result = await planner.plan("how's this machine doing?");
    expect(result).toEqual({ name: "get_asset_health", args: { assetId } });
  });

  it("falls back to clarify when there is no tool_calls entry at all", async () => {
    const fetchImpl = mockFetch({ choices: [{ message: { content: "I need more detail — which branch?" } }] });
    const planner = new DeepSeekPlanner({ baseUrl: "https://x", apiKey: "k", fetchImpl });

    const result = await planner.plan("check the branch");
    expect(result).toEqual({ clarify: "I need more detail — which branch?" });
  });

  it("falls back to clarify, never throws, when tool arguments are malformed JSON", async () => {
    // DeepSeek's own docs: "Generated tool arguments may not always be
    // valid JSON and should be validated before your application calls
    // the function." This is that validation actually being exercised.
    const fetchImpl = mockFetch({
      choices: [{ message: { tool_calls: [{ function: { name: "get_asset_health", arguments: "{not valid json" } }] } }],
    });
    const planner = new DeepSeekPlanner({ baseUrl: "https://x", apiKey: "k", fetchImpl });

    const result = await planner.plan("how's this machine doing?");
    expect(result).toHaveProperty("clarify");
    expect((result as any).clarify).toMatch(/malformed arguments/);
  });

  it("falls back to clarify rather than guessing when content is empty and there's no tool_calls (a leaked-DSML-shaped failure)", async () => {
    // Documented vLLM failure mode: DeepSeek's DSML tool-call markup can
    // leak into content or vanish under thinking mode instead of producing
    // a structured tool_calls entry. The planner must never try to
    // regex-recover a tool call from raw text itself — that would mean
    // trusting unparsed model output as if it were the API contract.
    const fetchImpl = mockFetch({ choices: [{ message: { content: null } }] });
    const planner = new DeepSeekPlanner({ baseUrl: "https://x", apiKey: "k", fetchImpl });

    const result = await planner.plan("anything");
    expect(result).toHaveProperty("clarify");
  });

  it("throws on a non-2xx response rather than silently returning an empty answer", async () => {
    const fetchImpl = mockFetch({ error: "rate limited" }, 429);
    const planner = new DeepSeekPlanner({ baseUrl: "https://x", apiKey: "k", fetchImpl });

    await expect(planner.plan("anything")).rejects.toThrow(/429/);
  });
});
