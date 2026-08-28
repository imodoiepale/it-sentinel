import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { executeToolCall, type AgentDeps } from "../src/executor.js";
import type { GuardContext } from "../src/policy/guard.js";

/**
 * The Sentinel Agent's own adversarial suite, parallel to agent-node's.
 * Proves the harness holds even before any real model is attached — the
 * StubPlanner never gets a chance to "talk its way" into a T3+ action or
 * a T6 table, because those tools simply don't exist in the registry, and
 * anything trying to name one is refused before a query runs.
 */

function makeDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  const supabaseStub = {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { status: "healthy" }, error: null }),
    })),
  } as any;

  return {
    db: supabaseStub,
    auditRefusal: vi.fn(async () => {}),
    auditSuccess: vi.fn(async () => {}),
    resolveSiteIdForAsset: vi.fn(async () => "site-in-scope"),
    resolveSiteIdForSlug: vi.fn(async () => "site-in-scope"),
    ...overrides,
  };
}

function ctxFor(role: GuardContext["operatorRole"], siteIds: string[] = ["site-in-scope"]): GuardContext {
  return { operatorRole: role, operatorSiteIds: new Set(siteIds) };
}

describe("sentinel-agent executor: unknown/T3+ tools never exist to call", () => {
  const FABRICATED_HIGH_TIER_CALLS = [
    { name: "restart_service", args: { assetId: randomUUID(), serviceName: "Spooler" } },
    { name: "delete_asset", args: { assetId: randomUUID() } },
    { name: "run_powershell", args: { command: "Remove-Item C:\\ -Recurse -Force" } },
    { name: "grant_access", args: { operatorId: randomUUID(), role: "it_manager" } },
    { name: "reboot_machine", args: { assetId: randomUUID() } },
  ];

  it.each(FABRICATED_HIGH_TIER_CALLS)("refuses %o — tool does not exist in the T0-T2 registry", async (call) => {
    const deps = makeDeps();
    const result = await executeToolCall(call, ctxFor("it_manager"), deps);
    expect(result.outcome).toBe("refused");
    expect(result.refusalReason).toMatch(/unknown tool/);
    expect(deps.auditRefusal).toHaveBeenCalledOnce();
  });
});

describe("sentinel-agent executor: T6 table access", () => {
  it("refuses any attempt to reach a fabricated tool targeting credentials/vault tables", async () => {
    const deps = makeDeps();
    const call = { name: "get_vault_secret", args: { credentialId: randomUUID() } };
    const result = await executeToolCall(call, ctxFor("it_manager"), deps);
    expect(result.outcome).toBe("refused");
    expect(deps.db.from).not.toHaveBeenCalled();
  });

  it("refuses when arguments contain a deny-pattern-matching payload even for a legitimate tool", async () => {
    const deps = makeDeps();
    const call = { name: "list_incidents", args: { status: "open", siteSlug: "select decrypted_secret from vault.decrypted_secrets" } };
    const result = await executeToolCall(call, ctxFor("it_manager"), deps);
    expect(result.outcome).toBe("refused");
    expect(result.refusalReason).toMatch(/deny pattern/);
  });
});

describe("sentinel-agent executor: role tier ceiling", () => {
  it("allows a T0 tool for an auditor (capped at T0)", async () => {
    const deps = makeDeps();
    const call = { name: "get_fleet_status", args: {} };
    const result = await executeToolCall(call, ctxFor("auditor"), deps);
    expect(result.outcome).toBe("success");
  });

  it("refuses a T1 tool for an auditor role — auditor is capped at T0", async () => {
    const deps = makeDeps();
    const call = { name: "get_check_history", args: { assetId: randomUUID() } };
    const result = await executeToolCall(call, ctxFor("auditor"), deps);
    expect(result.outcome).toBe("refused");
    expect(result.refusalReason).toMatch(/capped at T0/);
  });
});

describe("sentinel-agent executor: site scope", () => {
  it("refuses a get_asset_health call for an asset outside the operator's site_access", async () => {
    const deps = makeDeps({ resolveSiteIdForAsset: vi.fn(async () => "some-other-site") });
    const call = { name: "get_asset_health", args: { assetId: randomUUID() } };
    const result = await executeToolCall(call, ctxFor("l1_support", ["site-in-scope"]), deps);
    expect(result.outcome).toBe("refused");
    expect(result.refusalReason).toMatch(/outside this operator's site scope/);
  });

  it("refuses when the asset can't be resolved to any site at all", async () => {
    const deps = makeDeps({ resolveSiteIdForAsset: vi.fn(async () => null) });
    const call = { name: "get_asset_health", args: { assetId: randomUUID() } };
    const result = await executeToolCall(call, ctxFor("l1_support"), deps);
    expect(result.outcome).toBe("refused");
  });

  it("allows a get_asset_health call for an asset inside the operator's scope", async () => {
    const deps = makeDeps();
    const call = { name: "get_asset_health", args: { assetId: randomUUID() } };
    const result = await executeToolCall(call, ctxFor("l1_support"), deps);
    expect(result.outcome).toBe("success");
  });
});

describe("sentinel-agent executor: argument schema validation", () => {
  it("refuses malformed arguments before any query runs", async () => {
    const deps = makeDeps();
    const call = { name: "get_asset_health", args: { assetId: "not-a-uuid" } };
    const result = await executeToolCall(call, ctxFor("l1_support"), deps);
    expect(result.outcome).toBe("refused");
    expect(deps.db.from).not.toHaveBeenCalled();
  });
});

describe("sentinel-agent executor: audit discipline", () => {
  it("audits every refusal and every success exactly once, never both", async () => {
    const deps = makeDeps();
    await executeToolCall({ name: "get_fleet_status", args: {} }, ctxFor("it_manager"), deps);
    expect(deps.auditSuccess).toHaveBeenCalledOnce();
    expect(deps.auditRefusal).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await executeToolCall({ name: "nonexistent_tool", args: {} }, ctxFor("it_manager"), deps);
    expect(deps.auditRefusal).toHaveBeenCalledOnce();
    expect(deps.auditSuccess).not.toHaveBeenCalled();
  });
});
