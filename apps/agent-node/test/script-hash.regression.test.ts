import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRequest } from "@it-sentinel/contracts";
import { hashScriptContent } from "@it-sentinel/contracts/script-hash";
import { executeCommand, ExecutorDeps, ScriptManifest } from "../src/exec/executor.js";

/**
 * Regression guard for a bug that silently disabled the ENTIRE playbook
 * library on every Windows agent.
 *
 * .gitattributes had `* text=auto`, so .ps1 files were stored LF and checked
 * out CRLF on Windows. The committed manifest hashes were computed on LF
 * content, the executor hashed the CRLF bytes on disk, the two never
 * matched, and every signed script was refused with a hash mismatch — on
 * every machine, for every playbook, with no symptom other than "the fix
 * didn't run".
 *
 * The fix is hashScriptContent(), which normalizes line endings on both the
 * generator and executor sides. These tests fail if either side stops using
 * it, or if the two implementations ever diverge.
 */

const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "scripts", "library");

describe("script hashing is line-ending independent", () => {
  it("hashes CRLF and LF content identically", () => {
    const lf = "Write-Output 'a'\nWrite-Output 'b'\n";
    const crlf = "Write-Output 'a'\r\nWrite-Output 'b'\r\n";
    expect(hashScriptContent(crlf)).toBe(hashScriptContent(lf));
  });

  it("still distinguishes genuinely different content", () => {
    // Normalization must not be so aggressive that it stops detecting
    // tampering — that would defeat hash pinning entirely.
    expect(hashScriptContent("Restart-Service Spooler\n")).not.toBe(
      hashScriptContent("Restart-Service Spooler; whoami\n"),
    );
  });

  it("treats Buffer and string input identically", () => {
    const text = "Write-Output 'x'\n";
    expect(hashScriptContent(Buffer.from(text, "utf-8"))).toBe(hashScriptContent(text));
  });
});

describe("every committed manifest matches its script on disk", () => {
  const manifests = readdirSync(LIB_DIR).filter((f) => f.endsWith(".manifest.json"));

  it("finds the script library", () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  for (const file of manifests) {
    const manifest = JSON.parse(readFileSync(join(LIB_DIR, file), "utf-8"));

    it(`${manifest.scriptId}: disk hash matches manifest`, () => {
      // This is the exact comparison the executor makes. If it fails here,
      // that script is dead on every agent — regenerate with
      // `pnpm --filter @it-sentinel/scripts manifest`.
      const content = readFileSync(join(LIB_DIR, manifest.scriptPath));
      expect(hashScriptContent(content)).toBe(manifest.sha256);
    });
  }
});

describe("executor accepts a real script regardless of checkout line endings", () => {
  function makeDeps(content: string, sha256: string): ExecutorDeps {
    return {
      loadScriptManifest: vi.fn(
        async (scriptId): Promise<ScriptManifest> => ({ scriptId, sha256, path: "fake.ps1", tier: "T3" }),
      ),
      readScriptContent: vi.fn(async () => Buffer.from(content, "utf-8")),
      runPowerShell: vi.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0 })),
      auditRefusal: vi.fn(async () => {}),
    };
  }

  const LF_SCRIPT = "Restart-Service -Name Spooler\nWrite-Output 'done'\n";
  const CANONICAL = hashScriptContent(LF_SCRIPT);

  function request(): CommandRequest {
    return CommandRequest.parse({
      commandId: randomUUID(),
      assetId: randomUUID(),
      operatorId: randomUUID(),
      tier: "T3",
      kind: "signed_script",
      scriptId: "restart-spooler",
      scriptSha256: CANONICAL,
    });
  }

  it("runs when the checkout produced LF", async () => {
    const deps = makeDeps(LF_SCRIPT, CANONICAL);
    const result = await executeCommand(request(), deps);
    expect(result.outcome).toBe("success");
    expect(deps.runPowerShell).toHaveBeenCalled();
  });

  it("runs when the checkout produced CRLF — the bug this guards", async () => {
    const deps = makeDeps(LF_SCRIPT.replace(/\n/g, "\r\n"), CANONICAL);
    const result = await executeCommand(request(), deps);
    expect(result.outcome).toBe("success");
    expect(deps.runPowerShell).toHaveBeenCalled();
  });

  it("still refuses genuinely tampered content", async () => {
    const tampered = "Restart-Service -Name Spooler\nwhoami\n";
    const deps = makeDeps(tampered, CANONICAL);
    const result = await executeCommand(request(), deps);
    expect(result.outcome).toBe("refused");
    expect(result.refusalReason).toContain("hash mismatch");
    expect(deps.runPowerShell).not.toHaveBeenCalled();
  });
});
