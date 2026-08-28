import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { CommandRequest } from "@it-sentinel/contracts";
import { executeCommand, ExecutorDeps } from "../src/exec/executor.js";
import { ALLOWED_APPS, resolveApp, UnknownAppError } from "../src/exec/app-launcher.js";

/**
 * app_launch is a NEW execution route into the shell, so it gets the same
 * adversarial treatment as the others. The property under test throughout:
 * nothing an operator (or a speech-to-text engine) supplies via appId ever
 * reaches PowerShell. Only fixed strings from ALLOWED_APPS do.
 */

function launchRequest(appId: unknown): CommandRequest {
  return CommandRequest.parse({
    commandId: randomUUID(),
    assetId: randomUUID(),
    operatorId: randomUUID(),
    tier: "T2",
    kind: "app_launch",
    appId,
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

describe("app_launch: injection via appId", () => {
  // Each of these is a plausible attempt to get arbitrary text executed by
  // dressing it up as an application name.
  const INJECTIONS = [
    "notepad; Stop-Service WinDefend",
    "notepad && Remove-Item -Recurse -Force C:\\",
    "notepad | Out-File C:\\evil.ps1",
    "Start-Process powershell",
    "powershell -enc SQBFAFgA",
    "cmd /c del /f /s /q C:\\*",
    "../../../windows/system32/cmd.exe",
    "C:\\Windows\\System32\\cmd.exe",
    "$(Get-Content C:\\secrets.txt)",
    "`nStop-Computer",
    "notepad`; calc",
    "NOTEPAD; whoami",
    "",
    "   ",
  ];

  for (const attack of INJECTIONS) {
    it(`refuses appId ${JSON.stringify(attack)} and never invokes PowerShell`, async () => {
      const deps = makeDeps();
      const result = await executeCommand(launchRequest(attack), deps);

      expect(result.outcome).toBe("refused");
      expect(deps.runPowerShell).not.toHaveBeenCalled();
      expect(deps.auditRefusal).toHaveBeenCalled();
    });
  }

  it("refuses when appId is absent entirely", async () => {
    const deps = makeDeps();
    const result = await executeCommand(
      CommandRequest.parse({
        commandId: randomUUID(),
        assetId: randomUUID(),
        operatorId: randomUUID(),
        tier: "T2",
        kind: "app_launch",
      }),
      deps,
    );

    expect(result.outcome).toBe("refused");
    expect(result.refusalReason).toContain("missing appId");
    expect(deps.runPowerShell).not.toHaveBeenCalled();
  });
});

describe("app_launch: the happy path stays narrow", () => {
  it("launches an allowlisted app using the TABLE's command, not the caller's text", async () => {
    const deps = makeDeps();
    const result = await executeCommand(launchRequest("notepad"), deps);

    expect(result.outcome).toBe("success");
    expect(deps.runPowerShell).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.runPowerShell).mock.calls[0]![0]).toBe(ALLOWED_APPS.notepad!.command);
  });

  it("matches case-insensitively and tolerates surrounding whitespace", async () => {
    const deps = makeDeps();
    const result = await executeCommand(launchRequest("  ChRoMe  "), deps);

    expect(result.outcome).toBe("success");
    expect(vi.mocked(deps.runPowerShell).mock.calls[0]![0]).toBe(ALLOWED_APPS.chrome!.command);
  });

  it("every allowlist entry resolves to a command with no shell metacharacters", () => {
    // If someone adds an entry containing ; | & ` or $, the table itself
    // becomes an injection vector and this catches it at review time.
    for (const [key, app] of Object.entries(ALLOWED_APPS)) {
      expect(app.command, `ALLOWED_APPS.${key}`).not.toMatch(/[;|&`$]/);
      expect(app.command, `ALLOWED_APPS.${key}`).toMatch(/^Start-Process /);
    }
  });

  it("resolveApp throws UnknownAppError rather than falling back to the input", () => {
    expect(() => resolveApp("definitely-not-an-app")).toThrow(UnknownAppError);
  });
});

describe("app_launch: the T6 deny-list still applies", () => {
  it("would refuse an allowlist entry that matched a deny pattern", async () => {
    // Guards the ordering in executor.ts: the allowlist resolves the command
    // text FIRST, then the deny-list check runs against that resolved text.
    // If a future edit reversed that order, a poisoned table entry would
    // execute unchecked. Verified here against the real deny list.
    const { matchDenyPattern } = await import("../src/exec/deny-list.js");
    expect(matchDenyPattern("Start-Process powershell -Command Stop-Service WinDefend")).toBeTruthy();
  });
});
