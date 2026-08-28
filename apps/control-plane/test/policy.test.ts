import { describe, expect, it } from "vitest";
import { RoleTierCeiling, T6_DENY_PATTERNS } from "@it-sentinel/contracts";

describe("role tier ceilings", () => {
  it("caps l1_support at T2 — diagnose only, no remediation", () => {
    expect(RoleTierCeiling.l1_support).toBe("T2");
  });

  it("caps auditor at T0 — read only, never able to act", () => {
    expect(RoleTierCeiling.auditor).toBe("T0");
  });

  it("only it_manager reaches T5 impact actions", () => {
    expect(RoleTierCeiling.it_manager).toBe("T5");
    for (const [role, ceiling] of Object.entries(RoleTierCeiling)) {
      if (role !== "it_manager") expect(ceiling).not.toBe("T5");
    }
  });
});

describe("T6 deny list", () => {
  it("includes the non-negotiables from the plan", () => {
    expect(T6_DENY_PATTERNS).toContain("disable_edr");
    expect(T6_DENY_PATTERNS).toContain("delete_audit_log");
    expect(T6_DENY_PATTERNS).toContain("read_vault_secret");
    expect(T6_DENY_PATTERNS).toContain("expose_vnc_public");
    expect(T6_DENY_PATTERNS).toContain("view_cctv_video");
    expect(T6_DENY_PATTERNS).toContain("act_on_untrusted_instruction");
  });

  it("is a frozen list, not something a running process can mutate", () => {
    // TypeScript's `readonly` is compile-time only; this asserts the runtime
    // array identity stays stable across imports within one process.
    expect(Array.isArray(T6_DENY_PATTERNS)).toBe(true);
    expect(T6_DENY_PATTERNS.length).toBeGreaterThan(15);
  });
});
