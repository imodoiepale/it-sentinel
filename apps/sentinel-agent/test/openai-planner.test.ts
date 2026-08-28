import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { OpenAiPlanner } from "../src/openai-planner.js";

/**
 * Same discipline as deepseek-planner.test.ts: prove the request matches
 * OpenAI's chat-completions tool-calling contract and that every response
 * shape a real endpoint can return — including the broken ones — resolves
 * to either a ToolCall or a clarification, never a crash. No key, no
 * network, no model.
 */

function mockFetch(responseBody: unknown, status = 200) {
  return vi.fn(async (url: string, init: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(responseBody),
    json: async () => responseBody,
  })) as unknown as typeof fetch;
}

describe("OpenAiPlanner: request shape", () => {
  it("POSTs to OpenAI's chat/completions with the default model, tools and tool_choice", async () => {
    const fetchImpl = mockFetch({ choices: [{ message: { tool_calls: [{ function: { name: "get_fleet_status", arguments: "{}" } }] } }] });
    const planner = new OpenAiPlanner({ apiKey: "test-key", fetchImpl });

    await planner.plan("what's the fleet status?");

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer test-key");

    const body = JSON.parse(init.body);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.tool_choice).toBe("auto");
    expect(body.messages).toEqual([
      { role: "system", content: expect.stringContaining("read-only") },
      { role: "user", content: "what's the fleet status?" },
    ]);
    expect(Array.isArray(body.tools)).toBe(true);
  });

  it("honours an explicit model and baseUrl override (Azure / gateway deployments)", async () => {
    const fetchImpl = mockFetch({ choices: [{ message: { content: "hm" } }] });
    const planner = new OpenAiPlanner({ apiKey: "k", model: "gpt-4o", baseUrl: "https://gateway.internal/v1", fetchImpl });

    await planner.plan("anything");

    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://gateway.internal/v1/chat/completions");
    expect(JSON.parse(init.body).model).toBe("gpt-4o");
  });

  it("advertises every registry tool, generated from the same schemas the executor enforces", async () => {
    const fetchImpl = mockFetch({ choices: [{ message: { content: "no tool needed" } }] });
    const planner = new OpenAiPlanner({ apiKey: "k", fetchImpl });
    await planner.plan("anything");

    const body = JSON.parse((fetchImpl as any).mock.calls[0][1].body);
    const toolNames = body.tools.map((t: any) => t.function.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(["get_asset_health", "get_fleet_status", "get_recurrence", "list_incidents", "get_check_history"]),
    );
    for (const tool of body.tools) {
      expect(tool.type).toBe("function");
      expect(tool.function.parameters.additionalProperties).toBe(false);
      // Strict mode is off for OpenAI on purpose — see the comment on
      // OpenAiPlanner.toolSpecs. Strict would force optional filters like
      // siteSlug into `required`, making the model invent a branch filter.
      expect(tool.function.strict).toBe(false);
    }
  });
});

describe("OpenAiPlanner: response parsing", () => {
  it("parses a tool_call into a ToolCall with args as a real object", async () => {
    const assetId = randomUUID();
    const fetchImpl = mockFetch({
      choices: [{ message: { tool_calls: [{ function: { name: "get_asset_health", arguments: JSON.stringify({ assetId }) } }] } }],
    });
    const planner = new OpenAiPlanner({ apiKey: "k", fetchImpl });

    expect(await planner.plan("how's this machine doing?")).toEqual({ name: "get_asset_health", args: { assetId } });
  });

  it("returns the model's prose as a clarification when it chose no tool", async () => {
    const fetchImpl = mockFetch({ choices: [{ message: { content: "I need more detail — which branch?" } }] });
    const planner = new OpenAiPlanner({ apiKey: "k", fetchImpl });

    expect(await planner.plan("check the branch")).toEqual({ clarify: "I need more detail — which branch?" });
  });

  it("clarifies rather than throwing when tool arguments are malformed JSON", async () => {
    const fetchImpl = mockFetch({
      choices: [{ message: { tool_calls: [{ function: { name: "get_asset_health", arguments: "{not valid json" } }] } }],
    });
    const planner = new OpenAiPlanner({ apiKey: "k", fetchImpl });

    const result = await planner.plan("how's this machine doing?");
    expect((result as any).clarify).toMatch(/malformed arguments/);
  });

  it("clarifies on a 200 whose body isn't JSON at all (misconfigured proxy)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "<html>502</html>",
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    })) as unknown as typeof fetch;
    const planner = new OpenAiPlanner({ apiKey: "k", fetchImpl });

    expect(await planner.plan("anything")).toHaveProperty("clarify");
  });

  it("clarifies on an empty choices array rather than dereferencing undefined", async () => {
    const fetchImpl = mockFetch({ choices: [] });
    const planner = new OpenAiPlanner({ apiKey: "k", fetchImpl });

    expect(await planner.plan("anything")).toHaveProperty("clarify");
  });

  it("throws with the status code on a non-2xx rather than returning an empty answer", async () => {
    const fetchImpl = mockFetch({ error: { message: "Rate limit reached" } }, 429);
    const planner = new OpenAiPlanner({ apiKey: "k", fetchImpl });

    await expect(planner.plan("anything")).rejects.toThrow(/429/);
  });

  it("surfaces an auth failure as a thrown error, not a silent clarification", async () => {
    const fetchImpl = mockFetch({ error: { message: "Incorrect API key provided" } }, 401);
    const planner = new OpenAiPlanner({ apiKey: "bad", fetchImpl });

    await expect(planner.plan("anything")).rejects.toThrow(/401/);
  });
});
