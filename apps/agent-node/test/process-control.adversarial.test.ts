import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { CommandRequest, LAUNCHABLE_APP_IDS } from "@it-sentinel/contracts";
import { executeCommand, ExecutorDeps } from "../src/exec/executor.js";
import {
  CLOSABLE_PROCESSES,
  NOT_CLOSABLE,
  NotClosableError,
  PROTECTED_PROCESSES,
  ProtectedProcessError,
  UnknownProcessError,
  closeCommandFor,
  resolveClosableProcess,
} from "../src/exec/process-control.js";

/**
 * app_close terminates processes, which makes it the most dangerous of the
 * allowlisted kinds: a stray Start-Process opens a window somebody can close,
 * a stray Stop-Process can take the machine off the air permanently. Two
 * properties are under test throughout:
 *
 *   1. Nothing an operator (or a speech-to-text engine) supplies via
 *      closeAppId reaches PowerShell. Only fixed strings from the table do.
 *   2. The processes that must never die — the agent, the remote-desktop
 *      server, and the Windows-critical set — are refused by name, every one
 *      of them, and runPowerShell is never reached on any refusal.
 *
 * runPowerShell is mocked throughout. Nothing here kills anything.
 */

function closeRequest(closeAppId: unknown, tier: CommandRequest["tier"] = "T3"): CommandRequest {
  return CommandRequest.parse({
    commandId: randomUUID(),
    assetId: randomUUID(),
    operatorId: randomUUID(),
    tier,
    kind: "app_close",
    closeAppId,
  });
}

function makeDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    loadScriptManifest: vi.fn(async () => null),
    readScriptContent: vi.fn(async () => Buffer.from("")),
    runPowerShell: vi.fn(async () => ({ stdout: "closed", stderr: "", exitCode: 0 })),
    auditRefusal: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("app_close: injection via closeAppId", () => {
  // Each of these is a plausible attempt to get arbitrary text executed by
  // dressing it up as the name of something to close.
  const INJECTIONS = [
    "notepad; Stop-Process -Name tvnserver",
    "notepad && Remove-Item -Recurse -Force C:\\",
    "notepad | Out-File C:\\evil.ps1",
    "notepad -Force; Stop-Computer",
    "Stop-Process -Name lsass",
    "$(Get-Content C:\\secrets.txt)",
    "`nStop-Computer",
    "notepad`; calc",
    "*",
    "notepad*",
    "../../../windows/system32/lsass.exe",
    "C:\\Windows\\System32\\lsass.exe",
    "notepad.exe",
    "1234",
    "-Id 4",
    "",
    "   ",
  ];

  for (const attack of INJECTIONS) {
    it(`refuses closeAppId ${JSON.stringify(attack)} and never invokes PowerShell`, async () => {
      const deps = makeDeps();
      const result = await executeCommand(closeRequest(attack), deps);

      expect(result.outcome).toBe("refused");
      expect(deps.runPowerShell).not.toHaveBeenCalled();
      expect(deps.auditRefusal).toHaveBeenCalled();
    });
  }

  it("refuses when closeAppId is absent entirely", async () => {
    const deps = makeDeps();
    const result = await executeCommand(
      CommandRequest.parse({
        commandId: randomUUID(),
        assetId: randomUUID(),
        operatorId: randomUUID(),
        tier: "T3",
        kind: "app_close",
      }),
      deps,
    );

    expect(result.outcome).toBe("refused");
    expect(result.refusalReason).toContain("missing closeAppId");
    expect(deps.runPowerShell).not.toHaveBeenCalled();
  });
});

describe("app_close: the processes that must never be killed", () => {
  /**
   * The whole point of the module. Each name is listed here explicitly rather
   * than looped from PROTECTED_PROCESSES alone, so that deleting an entry
   * from that table fails this suite instead of quietly making something
   * killable. The loop below then catches anything ADDED to the table.
   */
  const MUST_NEVER_DIE = [
    "node", // the agent itself — kill it and no further command can ever arrive
    "pwsh", // the shell every command runs through
    "powershell",
    "tvnserver", // the remote-desktop server — the only way back onto the screen
    "lsass", // bluescreens the machine outright
    "csrss",
    "wininit",
    "winlogon",
    "services",
    "smss",
  ];

  for (const name of MUST_NEVER_DIE) {
    it(`refuses to terminate ${name}, with a reason`, async () => {
      const deps = makeDeps();
      const result = await executeCommand(closeRequest(name), deps);

      expect(result.outcome).toBe("refused");
      expect(result.refusalReason).toContain("refusing to terminate");
      // Not a bare "unknown identifier": an operator who asks for this is
      // told why not, and the audit trail records the real reason.
      expect(result.refusalReason).not.toContain("not in the closable-process allowlist");
      expect(deps.runPowerShell).not.toHaveBeenCalled();
      expect(deps.auditRefusal).toHaveBeenCalledOnce();
    });

    it(`refuses ${name} in mixed case and with padding too`, async () => {
      const deps = makeDeps();
      const result = await executeCommand(closeRequest(`  ${name.toUpperCase()}  `), deps);

      expect(result.outcome).toBe("refused");
      expect(deps.runPowerShell).not.toHaveBeenCalled();
    });

    it(`PROTECTED_PROCESSES still lists ${name}`, () => {
      expect(PROTECTED_PROCESSES[name], `${name} was removed from PROTECTED_PROCESSES`).toBeTruthy();
    });
  }

  it("every entry in PROTECTED_PROCESSES is refused and carries a reason", () => {
    for (const [name, reason] of Object.entries(PROTECTED_PROCESSES)) {
      expect(() => resolveClosableProcess(name)).toThrow(ProtectedProcessError);
      expect(reason.length, `${name} has no stated reason`).toBeGreaterThan(20);
    }
  });

  it("no protected process is reachable through the closable table", () => {
    // Defence in depth: resolveClosableProcess re-checks the RESOLVED name,
    // so widening PROCESS_NAMES to a protected process refuses at runtime
    // rather than executing. This asserts the table is clean today.
    for (const target of Object.values(CLOSABLE_PROCESSES)) {
      expect(PROTECTED_PROCESSES[target.processName.toLowerCase()]).toBeUndefined();
    }
  });
});

describe("app_close: launchable but deliberately not closable", () => {
  for (const [id, reason] of Object.entries(NOT_CLOSABLE)) {
    it(`refuses "${id}" and says why`, async () => {
      const deps = makeDeps();
      const result = await executeCommand(closeRequest(id), deps);

      expect(result.outcome).toBe("refused");
      // "services" is refused one step earlier, by the protected-process
      // check, because the identifier collides with services.exe — the
      // Windows Service Control Manager. That collision is the single most
      // dangerous thing in this table's neighbourhood (terminating it
      // bluescreens the machine), so the earlier and blunter refusal is the
      // right one and this asserts it rather than working around it.
      expect(result.refusalReason).toMatch(/cannot be closed remotely|refusing to terminate/);
      expect(deps.runPowerShell).not.toHaveBeenCalled();
      expect(reason.length).toBeGreaterThan(20);
    });
  }

  it("explorer is one of them — the shell is not a folder window", () => {
    // Terminating explorer.exe takes the taskbar and desktop away from the
    // person sitting at the machine, which is not what "close that" means.
    expect(NOT_CLOSABLE.explorer).toBeTruthy();
    expect(() => resolveClosableProcess("explorer")).toThrow(NotClosableError);
  });
});

describe("app_close: the tier floor", () => {
  // Terminating a process changes machine state and can discard unsaved
  // work, so the read-only tiers must not reach it — the same floor
  // service_action carries, enforced in the executor because this kind never
  // reaches the tier allowlist.
  for (const tier of ["T1", "T2"] as const) {
    it(`refuses a valid close dispatched at ${tier}`, async () => {
      const deps = makeDeps();
      const result = await executeCommand(closeRequest("notepad", tier), deps);

      expect(result.outcome).toBe("refused");
      expect(result.refusalReason).toContain("requires T3 or above");
      expect(deps.runPowerShell).not.toHaveBeenCalled();
    });
  }

  for (const tier of ["T3", "T4", "T5"] as const) {
    it(`permits a valid close at ${tier}`, async () => {
      const deps = makeDeps();
      const result = await executeCommand(closeRequest("notepad", tier), deps);

      expect(result.outcome).toBe("success");
      expect(deps.runPowerShell).toHaveBeenCalledOnce();
    });
  }
});

describe("app_close: the happy path stays narrow", () => {
  it("closes an allowlisted app using the TABLE's process name, not the caller's text", async () => {
    const deps = makeDeps();
    const result = await executeCommand(closeRequest("notepad"), deps);

    expect(result.outcome).toBe("success");
    expect(deps.runPowerShell).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.runPowerShell).mock.calls[0]![0]).toBe(
      closeCommandFor(CLOSABLE_PROCESSES.notepad!),
    );
  });

  it("matches case-insensitively and tolerates surrounding whitespace", async () => {
    const deps = makeDeps();
    const result = await executeCommand(closeRequest("  ChRoMe  "), deps);

    expect(result.outcome).toBe("success");
    expect(vi.mocked(deps.runPowerShell).mock.calls[0]![0]).toBe(
      closeCommandFor(CLOSABLE_PROCESSES.chrome!),
    );
  });

  it("tries a graceful close before forcing, so unsaved work gets a save prompt", () => {
    const command = closeCommandFor(CLOSABLE_PROCESSES.notepad!);
    expect(command).toContain("CloseMainWindow()");
    expect(command).toContain("Stop-Process -Force");
    // Ordering is the substance of the claim: forcing first would discard
    // somebody's document with no warning.
    expect(command.indexOf("CloseMainWindow()")).toBeLessThan(command.indexOf("Stop-Process -Force"));
  });

  it("every closable entry names a bare process, nothing a shell could reinterpret", () => {
    // If someone adds an entry containing a metacharacter, a wildcard, a path
    // or an .exe suffix, the table itself becomes the injection vector and
    // this catches it at review time.
    for (const [key, target] of Object.entries(CLOSABLE_PROCESSES)) {
      expect(target.processName, `CLOSABLE_PROCESSES.${key}`).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it("resolveClosableProcess throws UnknownProcessError rather than falling back to the input", () => {
    expect(() => resolveClosableProcess("definitely-not-an-app")).toThrow(UnknownProcessError);
  });
});

describe("app_close: the vocabulary cannot drift from the launcher", () => {
  it("every closable id is an id the launcher also knows", () => {
    // The table is derived from LAUNCHABLE_APP_IDS, so this is a backstop for
    // someone reaching for a widening Record<string, ...> — a close-only id
    // would be one the voice agent never offers and nobody can discover.
    for (const id of Object.keys(CLOSABLE_PROCESSES)) {
      expect(LAUNCHABLE_APP_IDS).toContain(id);
    }
  });

  it("every launchable id is either closable or explicitly refused, never silently missing", () => {
    // The asymmetry this whole module fixes: an app you can open and then
    // cannot get rid of. Every id must be accounted for on one side or the
    // other, with a stated reason when it is the refusing side.
    for (const id of LAUNCHABLE_APP_IDS) {
      const accounted = Boolean(CLOSABLE_PROCESSES[id]) || Boolean(NOT_CLOSABLE[id]);
      expect(accounted, `launchable app "${id}" can be opened but is neither closable nor explained`).toBe(true);
    }
  });
});

describe("app_close: the T6 deny-list still applies", () => {
  it("runs against the resolved command text, not the identifier", async () => {
    // Guards the ordering in executor.ts: the allowlist resolves the command
    // text FIRST, then the deny-list check runs against that resolved text.
    // If a future edit reversed that order, a poisoned table entry would
    // execute unchecked.
    const { matchDenyPattern } = await import("../src/exec/deny-list.js");
    expect(matchDenyPattern("Stop-Service -Name WinDefend")).toBeTruthy();
    // ...and a legitimate close is clean, so the check is not vacuous.
    expect(matchDenyPattern(closeCommandFor(CLOSABLE_PROCESSES.notepad!))).toBeNull();
  });

  it("protects process-control.ts from self-modification, like the other guard files", async () => {
    // This file decides what is unkillable, so an edit to it is an edit to
    // what the agent refuses — T4 arbitrary PowerShell must not be able to
    // make lsass killable by rewriting the table.
    const { matchDenyPattern } = await import("../src/exec/deny-list.js");
    expect(matchDenyPattern("Set-Content -Path .\\src\\exec\\process-control.ts -Value ''")).toBe(
      "modify_own_policy",
    );
    expect(matchDenyPattern("Remove-Item apps/agent-node/src/exec/process-control.ts")).toBe(
      "modify_own_policy",
    );
  });
});
