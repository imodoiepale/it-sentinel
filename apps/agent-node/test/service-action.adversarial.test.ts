import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { CommandRequest } from "@it-sentinel/contracts";
import { executeCommand, ExecutorDeps } from "../src/exec/executor.js";
import {
  ALLOWED_SERVICES,
  resolveService,
  serviceCommandFor,
  UnknownServiceError,
} from "../src/exec/service-actions.js";

/**
 * service_action existed in the contract, and the control plane dispatched
 * it, for the whole time the executor had no branch for it. Such a request
 * fell past every check with an empty command string, ran `pwsh -Command ""`
 * and reported outcome "success" — "restarted the print spooler" with nothing
 * restarted. This suite exists to keep that from coming back, and to give the
 * new route the same adversarial treatment as the others.
 *
 * The property under test throughout: nothing an operator (or a
 * speech-to-text engine) supplies via serviceName ever reaches PowerShell.
 * Only fixed strings from ALLOWED_SERVICES do.
 */

function serviceRequest(
  serviceName: unknown,
  serviceAction: unknown = "restart",
  tier = "T3",
): CommandRequest {
  return CommandRequest.parse({
    commandId: randomUUID(),
    assetId: randomUUID(),
    operatorId: randomUUID(),
    tier,
    kind: "service_action",
    serviceName,
    serviceAction,
  });
}

function makeDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    loadScriptManifest: vi.fn(async () => null),
    readScriptContent: vi.fn(async () => Buffer.from("")),
    runPowerShell: vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0 })),
    auditRefusal: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("service_action: the empty-command regression", () => {
  it("never invokes PowerShell with empty text for a valid request", async () => {
    // The exact shape of the original bug: this used to call
    // runPowerShell("", ...) and report success.
    const deps = makeDeps();
    const result = await executeCommand(serviceRequest("spooler", "restart"), deps);

    expect(result.outcome).toBe("success");
    expect(deps.runPowerShell).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.runPowerShell).mock.calls[0]![0]).toBe("Restart-Service -Name Spooler");
  });

  it("never invokes PowerShell with empty text for a refused request either", async () => {
    const deps = makeDeps();
    await executeCommand(serviceRequest("not-a-real-service"), deps);

    expect(deps.runPowerShell).not.toHaveBeenCalled();
  });

  it("refuses rather than executing when a kind yields no command text", async () => {
    // The backstop in executor.ts, driven through the one kind that can still
    // reach it: an adhoc request whose command text is blank. Without it, the
    // next kind added to CommandKind reintroduces the silent no-op.
    const deps = makeDeps();
    const result = await executeCommand(
      CommandRequest.parse({
        commandId: randomUUID(),
        assetId: randomUUID(),
        operatorId: randomUUID(),
        tier: "T2",
        kind: "adhoc_powershell",
        adhocCommand: "   ",
      }),
      deps,
    );

    expect(result.outcome).toBe("refused");
    expect(result.refusalReason).toContain("no command text");
    expect(deps.runPowerShell).not.toHaveBeenCalled();
  });
});

describe("service_action: injection via serviceName", () => {
  // Each of these is a plausible attempt to get arbitrary text executed by
  // dressing it up as a service name.
  const INJECTIONS = [
    "Spooler; whoami",
    "Spooler && shutdown /r",
    "Spooler | Out-File C:\\evil.ps1",
    "Spooler; Stop-Service WinDefend",
    "$(whoami)",
    "`nStop-Computer",
    "Spooler`; calc",
    "Spooler*",
    "../../../windows/system32/cmd.exe",
    "..\\..\\Spooler",
    "C:\\Windows\\System32\\cmd.exe",
    "-Name Spooler -Force; Clear-EventLog Security",
    "",
    "   ",
  ];

  for (const attack of INJECTIONS) {
    it(`refuses serviceName ${JSON.stringify(attack)} and never invokes PowerShell`, async () => {
      const deps = makeDeps();
      const result = await executeCommand(serviceRequest(attack), deps);

      expect(result.outcome).toBe("refused");
      expect(deps.runPowerShell).not.toHaveBeenCalled();
      expect(deps.auditRefusal).toHaveBeenCalled();
    });
  }

  it("refuses an unknown service outright rather than passing the name through", async () => {
    const deps = makeDeps();
    const result = await executeCommand(serviceRequest("TotallyLegitService"), deps);

    expect(result.outcome).toBe("refused");
    expect(result.refusalReason).toContain("not in the manageable-service allowlist");
    expect(deps.runPowerShell).not.toHaveBeenCalled();
  });

  it("refuses when serviceName is absent entirely", async () => {
    const deps = makeDeps();
    const result = await executeCommand(
      CommandRequest.parse({
        commandId: randomUUID(),
        assetId: randomUUID(),
        operatorId: randomUUID(),
        tier: "T3",
        kind: "service_action",
        serviceAction: "restart",
      }),
      deps,
    );

    expect(result.outcome).toBe("refused");
    expect(result.refusalReason).toContain("missing serviceName or serviceAction");
    expect(deps.runPowerShell).not.toHaveBeenCalled();
  });

  it("refuses when serviceAction is absent entirely", async () => {
    const deps = makeDeps();
    const result = await executeCommand(
      CommandRequest.parse({
        commandId: randomUUID(),
        assetId: randomUUID(),
        operatorId: randomUUID(),
        tier: "T3",
        kind: "service_action",
        serviceName: "spooler",
      }),
      deps,
    );

    expect(result.outcome).toBe("refused");
    expect(result.refusalReason).toContain("missing serviceName or serviceAction");
    expect(deps.runPowerShell).not.toHaveBeenCalled();
  });

  it("refuses an action the contract does not define, before any text is built", async () => {
    const deps = makeDeps();
    expect(() => serviceRequest("spooler", "disable")).toThrow();
    expect(deps.runPowerShell).not.toHaveBeenCalled();
  });
});

describe("service_action: the T6 deny-list still applies", () => {
  // "stop defender" is refused by the T6 deny list, NOT by the service
  // allowlist — WinDefend is deliberately in ALLOWED_SERVICES so that the
  // refusal comes from the mechanism that cannot be reached around. If a
  // future edit built the command text AFTER the deny-list check, or dropped
  // WinDefend from the table and called that a fix, these fail.
  for (const tier of ["T3", "T4", "T5"] as const) {
    it(`refuses "stop defender" at ${tier} with a deny-pattern reason`, async () => {
      const deps = makeDeps();
      const result = await executeCommand(serviceRequest("defender", "stop", tier), deps);

      expect(result.outcome).toBe("refused");
      expect(result.refusalReason).toContain("matches T6 deny pattern");
      expect(result.refusalReason).toContain("disable_antivirus");
      expect(deps.runPowerShell).not.toHaveBeenCalled();
    });
  }

  it("proves the refusal is the deny list's doing, not the allowlist's", async () => {
    // WinDefend resolves fine and the generated text is well-formed; it is
    // the deny list, run against that generated text, that stops it.
    const service = resolveService("defender");
    expect(service.serviceName).toBe("WinDefend");

    const { matchDenyPattern } = await import("../src/exec/deny-list.js");
    expect(matchDenyPattern(serviceCommandFor("stop", service))).toBe("disable_antivirus");
  });

  it("still permits starting Defender, which is not a deny-list offence", async () => {
    const deps = makeDeps();
    const result = await executeCommand(serviceRequest("defender", "start"), deps);

    expect(result.outcome).toBe("success");
    expect(vi.mocked(deps.runPowerShell).mock.calls[0]![0]).toBe("Start-Service -Name WinDefend");
  });
});

describe("service_action: tier floor", () => {
  for (const tier of ["T0", "T1", "T2"] as const) {
    it(`refuses a service action at ${tier}`, async () => {
      const deps = makeDeps();
      const result = await executeCommand(serviceRequest("spooler", "restart", tier), deps);

      expect(result.outcome).toBe("refused");
      expect(result.refusalReason).toContain("require T3 or above");
      expect(deps.runPowerShell).not.toHaveBeenCalled();
    });
  }

  it("refuses at T6, which is the deny tier and executes nothing", async () => {
    const deps = makeDeps();
    const result = await executeCommand(serviceRequest("spooler", "restart", "T6"), deps);

    expect(result.outcome).toBe("refused");
    expect(deps.runPowerShell).not.toHaveBeenCalled();
  });

  it("permits a service action at T3, the remediate tier", async () => {
    const deps = makeDeps();
    const result = await executeCommand(serviceRequest("spooler", "restart", "T3"), deps);

    expect(result.outcome).toBe("success");
    expect(vi.mocked(deps.runPowerShell).mock.calls[0]![0]).toBe("Restart-Service -Name Spooler");
  });
});

describe("service_action: the happy path stays narrow", () => {
  it("uses the TABLE's service name, not the caller's text", async () => {
    const deps = makeDeps();
    await executeCommand(serviceRequest("printer", "restart"), deps);

    expect(vi.mocked(deps.runPowerShell).mock.calls[0]![0]).toBe("Restart-Service -Name Spooler");
  });

  it("matches case-insensitively and tolerates surrounding whitespace", async () => {
    const deps = makeDeps();
    const result = await executeCommand(serviceRequest("  PRINT Spooler  ", "start"), deps);

    expect(result.outcome).toBe("success");
    expect(vi.mocked(deps.runPowerShell).mock.calls[0]![0]).toBe("Start-Service -Name Spooler");
  });

  it("maps each action to its cmdlet and nothing else", async () => {
    const spooler = resolveService("spooler");
    expect(serviceCommandFor("start", spooler)).toBe("Start-Service -Name Spooler");
    expect(serviceCommandFor("stop", spooler)).toBe("Stop-Service -Name Spooler");
    expect(serviceCommandFor("restart", spooler)).toBe("Restart-Service -Name Spooler");
  });

  it("every allowlist entry produces command text with no shell metacharacters", () => {
    // If someone adds an entry containing ; | & ` $ * or whitespace, the table
    // itself becomes an injection vector and this catches it at review time.
    for (const [key, service] of Object.entries(ALLOWED_SERVICES)) {
      expect(service.serviceName, `ALLOWED_SERVICES.${key}`).toMatch(/^[A-Za-z0-9_]+$/);

      for (const action of ["start", "stop", "restart"] as const) {
        const text = serviceCommandFor(action, service);
        expect(text, `ALLOWED_SERVICES.${key} (${action})`).not.toMatch(/[;|&`$*<>()'"]/);
        expect(text, `ALLOWED_SERVICES.${key} (${action})`).toMatch(
          /^(Start|Stop|Restart)-Service -Name [A-Za-z0-9_]+$/,
        );
      }
    }
  });

  it("every allowlist entry is reachable through the executor or refused by T6", async () => {
    // No entry may be a silent dud: each one either executes its exact
    // generated text, or is stopped by the deny list with a stated reason.
    for (const id of Object.keys(ALLOWED_SERVICES)) {
      const deps = makeDeps();
      const expected = serviceCommandFor("restart", resolveService(id));
      const result = await executeCommand(serviceRequest(id, "restart"), deps);

      if (result.outcome === "refused") {
        expect(result.refusalReason, id).toContain("matches T6 deny pattern");
        expect(deps.runPowerShell, id).not.toHaveBeenCalled();
      } else {
        expect(result.outcome, id).toBe("success");
        expect(vi.mocked(deps.runPowerShell).mock.calls[0]![0], id).toBe(expected);
      }
    }
  });

  it("resolveService throws UnknownServiceError rather than falling back to the input", () => {
    expect(() => resolveService("definitely-not-a-service")).toThrow(UnknownServiceError);
  });
});
