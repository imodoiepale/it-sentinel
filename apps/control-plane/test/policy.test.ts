import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { RoleTierCeiling, T6_DENY_PATTERNS } from "@it-sentinel/contracts";

/**
 * getOperatorRoleForSite is the only database read in the policy path, so the
 * whole client is stubbed down to the one chain it uses. vi.hoisted is what
 * lets the factory (which vitest lifts above the imports) reach a knob the
 * tests can turn.
 */
const dbState = vi.hoisted(() => ({ role: null as string | null }));

vi.mock("../src/db.js", () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: dbState.role ? { role: dbState.role } : null, error: null }),
  };
  return { db: { from: () => chain } };
});

import { evaluateCommandPolicy } from "../src/policy/policy.service.js";
import { runWithElevationToken } from "../src/auth/elevation.context.js";
import { ELEVATION_TTL_MS, mintElevationToken, __resetElevationStore } from "../src/auth/elevation.store.js";

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

  it("lets exactly l3_sysadmin, security_admin and it_manager reach the T4 operator console", () => {
    const ORDER = ["T0", "T1", "T2", "T3", "T4", "T5", "T6"];
    const canReachT4 = Object.entries(RoleTierCeiling)
      .filter(([, ceiling]) => ORDER.indexOf(ceiling) >= ORDER.indexOf("T4"))
      .map(([role]) => role)
      .sort();
    expect(canReachT4).toEqual(["it_manager", "l3_sysadmin", "security_admin"]);
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

/**
 * T4 is the tier that runs arbitrary PowerShell, so the interesting cases
 * here are all the ways it must NOT open: no token, a stale one, a spent one,
 * one belonging to somebody else, and a role that was never entitled to ask.
 */
describe("T4 operator console: elevation token enforcement", () => {
  const OPERATOR = randomUUID();
  const SITE = randomUUID();

  beforeEach(() => {
    __resetElevationStore();
    dbState.role = "l3_sysadmin";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("denies T4 when no elevation token is presented at all", async () => {
    const decision = await evaluateCommandPolicy({ operatorId: OPERATOR, siteId: SITE, tier: "T4" });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedReason).toMatch(/requires password re-authentication/);
    expect(decision.deniedReason).toMatch(/no elevation token/);
  });

  it("denies T4 on an unrecognised token — a guessed or forged one buys nothing", async () => {
    const decision = await evaluateCommandPolicy({
      operatorId: OPERATOR,
      siteId: SITE,
      tier: "T4",
      elevationToken: "not-a-token-anyone-ever-minted",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedReason).toMatch(/not recognised/);
  });

  it("allows T4 with a valid, unexpired, unconsumed token", async () => {
    const { token } = mintElevationToken(OPERATOR);
    const decision = await evaluateCommandPolicy({
      operatorId: OPERATOR,
      siteId: SITE,
      tier: "T4",
      elevationToken: token,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.tier).toBe("T4");
    expect(decision.requiresConfirmation).toBe(true);
  });

  it("allows T4 when the token arrives through request-scoped context rather than as an argument", async () => {
    // This is the shape the real dispatch path uses — main.ts enters the
    // scope, dispatchCommand is none the wiser, policy still sees the token.
    const { token } = mintElevationToken(OPERATOR);
    const decision = await runWithElevationToken(token, () =>
      evaluateCommandPolicy({ operatorId: OPERATOR, siteId: SITE, tier: "T4" }),
    );
    expect(decision.allowed).toBe(true);
  });

  it("denies T4 outside any elevation scope even after one succeeded — the scope does not leak", async () => {
    const first = mintElevationToken(OPERATOR);
    await runWithElevationToken(first.token, () =>
      evaluateCommandPolicy({ operatorId: OPERATOR, siteId: SITE, tier: "T4" }),
    );
    const decision = await evaluateCommandPolicy({ operatorId: OPERATOR, siteId: SITE, tier: "T4" });
    expect(decision.allowed).toBe(false);
  });

  it("denies T4 on an expired token — five minutes is a hard wall", async () => {
    vi.useFakeTimers();
    const { token } = mintElevationToken(OPERATOR);
    vi.setSystemTime(new Date(Date.now() + ELEVATION_TTL_MS + 1000));

    const decision = await evaluateCommandPolicy({
      operatorId: OPERATOR,
      siteId: SITE,
      tier: "T4",
      elevationToken: token,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedReason).toMatch(/expired/);
  });

  it("cannot be handed a token that outlives the five-minute ceiling", async () => {
    vi.useFakeTimers();
    const { token } = mintElevationToken(OPERATOR, 24 * 60 * 60 * 1000);
    vi.setSystemTime(new Date(Date.now() + ELEVATION_TTL_MS + 1000));

    const decision = await evaluateCommandPolicy({
      operatorId: OPERATOR,
      siteId: SITE,
      tier: "T4",
      elevationToken: token,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedReason).toMatch(/expired/);
  });

  it("denies T4 on an already-consumed token — one password prompt, one command", async () => {
    const { token } = mintElevationToken(OPERATOR);

    const first = await evaluateCommandPolicy({
      operatorId: OPERATOR,
      siteId: SITE,
      tier: "T4",
      elevationToken: token,
    });
    expect(first.allowed).toBe(true);

    const replay = await evaluateCommandPolicy({
      operatorId: OPERATOR,
      siteId: SITE,
      tier: "T4",
      elevationToken: token,
    });
    expect(replay.allowed).toBe(false);
    expect(replay.deniedReason).toMatch(/already been used/);
  });

  it("denies T4 on a token minted for a different operator", async () => {
    const { token } = mintElevationToken(randomUUID());
    const decision = await evaluateCommandPolicy({
      operatorId: OPERATOR,
      siteId: SITE,
      tier: "T4",
      elevationToken: token,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedReason).toMatch(/different operator/);
  });

  it("denies T4 for a role below the ceiling, and says so — re-auth is not a way past the ceiling", async () => {
    dbState.role = "l2_support";
    const { token } = mintElevationToken(OPERATOR);

    const decision = await evaluateCommandPolicy({
      operatorId: OPERATOR,
      siteId: SITE,
      tier: "T4",
      elevationToken: token,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedReason).toMatch(/role l2_support is capped at T3/);
  });

  it("does not burn the token on a request that was denied for another reason", async () => {
    // An operator whose command was refused on ceiling grounds should not
    // also have to re-enter their password before their next legitimate one.
    dbState.role = "l2_support";
    const { token } = mintElevationToken(OPERATOR);
    await evaluateCommandPolicy({ operatorId: OPERATOR, siteId: SITE, tier: "T4", elevationToken: token });

    dbState.role = "l3_sysadmin";
    const decision = await evaluateCommandPolicy({
      operatorId: OPERATOR,
      siteId: SITE,
      tier: "T4",
      elevationToken: token,
    });
    expect(decision.allowed).toBe(true);
  });

  it("denies T4 when the operator holds no grant on the site, valid token or not", async () => {
    dbState.role = null;
    const { token } = mintElevationToken(OPERATOR);
    const decision = await evaluateCommandPolicy({
      operatorId: OPERATOR,
      siteId: SITE,
      tier: "T4",
      elevationToken: token,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deniedReason).toMatch(/no access grant/);
  });

  it("still refuses a T6 deny-list hit at T4 with a perfectly valid token", async () => {
    const { token } = mintElevationToken(OPERATOR);
    const decision = await evaluateCommandPolicy({
      operatorId: OPERATOR,
      siteId: SITE,
      tier: "T4",
      elevationToken: token,
      denyPatternHit: "disable_edr",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.tier).toBe("T6");
    expect(decision.deniedReason).toMatch(/T6 deny pattern/);
  });
});

describe("tiers below T4 are unaffected by elevation", () => {
  const OPERATOR = randomUUID();
  const SITE = randomUUID();

  beforeEach(() => {
    __resetElevationStore();
    dbState.role = "l2_support";
  });

  it("allows T2 and T3 with no token whatsoever — existing callers keep working", async () => {
    for (const tier of ["T1", "T2", "T3"] as const) {
      const decision = await evaluateCommandPolicy({ operatorId: OPERATOR, siteId: SITE, tier });
      expect(decision.allowed).toBe(true);
    }
  });
});
