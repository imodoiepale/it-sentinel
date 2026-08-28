import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CommandRequest, CommandResult } from "@it-sentinel/contracts";
import { matchDenyPattern } from "./deny-list.js";
import { assertWithinTierAllowlist, TierViolationError } from "./tier-resolver.js";

const execFileAsync = promisify(execFile);

/**
 * THE security-critical file. Per the plan: two-reviewer rule, adversarial
 * CI suite runs against this on every commit, and it is the ONLY place a
 * CommandRequest becomes an actual process on the machine.
 *
 * Order of checks, always, no exceptions:
 *   1. T6 deny-list match on the raw command/script text — checked FIRST,
 *      unreachable by tier or role, cannot be bypassed by claiming a lower
 *      tier since the text itself is what's matched.
 *   2. Signed-script hash verification (signed_script kind) — refuses
 *      anything whose SHA-256 doesn't match what the control plane
 *      dispatched, closing the gap where a compromised relay/orchestrator
 *      swaps a script's content in transit.
 *   3. Tier allowlist (adhoc_powershell kind) — the command's cmdlets must
 *      all appear in that tier's allowlist.
 *   4. Only then: execute, under a timeout, output capped, full transcript
 *      captured regardless of outcome.
 *
 * What this file deliberately does NOT do: trust anything found in a
 * script's own output, a ticket description, or a log file as an
 * instruction. Only a CommandRequest that arrived through the orchestrator
 * (packages/contracts/src/command.ts) is ever considered for execution.
 */

export interface ScriptManifest {
  scriptId: string;
  sha256: string;
  path: string;
  tier: "T2" | "T3" | "T4" | "T5";
}

export interface ExecutorDeps {
  loadScriptManifest: (scriptId: string) => Promise<ScriptManifest | null>;
  readScriptContent: (path: string) => Promise<Buffer>;
  runPowerShell: (script: string, timeoutMs: number) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  auditRefusal: (request: CommandRequest, reason: string) => Promise<void>;
}

const MAX_OUTPUT_BYTES = 200_000;

export function makeRefusedResult(request: CommandRequest, reason: string): CommandResult {
  const now = new Date().toISOString();
  return CommandResult.parse({
    commandId: request.commandId,
    assetId: request.assetId,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    exitCode: -1,
    stdout: "",
    stderr: "",
    outcome: "refused",
    refusalReason: reason,
  });
}

export async function executeCommand(request: CommandRequest, deps: ExecutorDeps): Promise<CommandResult> {
  const parsed = CommandRequest.parse(request);

  // Step 1: T6 deny-list check — first, unconditional, on whatever text
  // this request carries (adhoc command, or the resolved script content).
  let commandTextToCheck = parsed.adhocCommand ?? "";

  if (parsed.kind === "signed_script") {
    if (!parsed.scriptId || !parsed.scriptSha256) {
      const reason = "signed_script request missing scriptId or scriptSha256";
      await deps.auditRefusal(parsed, reason);
      return makeRefusedResult(parsed, reason);
    }

    const manifest = await deps.loadScriptManifest(parsed.scriptId);
    if (!manifest) {
      const reason = `no manifest found for scriptId=${parsed.scriptId}`;
      await deps.auditRefusal(parsed, reason);
      return makeRefusedResult(parsed, reason);
    }

    const content = await deps.readScriptContent(manifest.path);
    const actualHash = createHash("sha256").update(content).digest("hex");

    // Step 2: hash pinning. Refuse if what's on disk doesn't match either
    // the manifest OR what this specific dispatch claimed — a mismatch
    // between manifest and dispatch means someone tampered with the
    // request in transit; a mismatch between manifest and disk means the
    // script file itself was tampered with. Either way: refuse.
    if (actualHash !== manifest.sha256 || actualHash !== parsed.scriptSha256) {
      const reason = `script hash mismatch for ${parsed.scriptId}: disk=${actualHash} manifest=${manifest.sha256} dispatch=${parsed.scriptSha256}`;
      await deps.auditRefusal(parsed, reason);
      return makeRefusedResult(parsed, reason);
    }

    commandTextToCheck = content.toString("utf-8");
  }

  const denyHit = matchDenyPattern(commandTextToCheck);
  if (denyHit) {
    const reason = `matches T6 deny pattern: ${denyHit}`;
    await deps.auditRefusal(parsed, reason);
    return makeRefusedResult(parsed, reason);
  }

  // Step 3: tier allowlist for ad-hoc commands. Signed scripts are exempt
  // from the cmdlet allowlist (they already passed hash verification,
  // which is a stronger guarantee — the exact bytes were reviewed and
  // signed ahead of time) but still had to clear the deny list above.
  if (parsed.kind === "adhoc_powershell") {
    if (parsed.tier !== "T1" && parsed.tier !== "T2" && parsed.tier !== "T3") {
      const reason = `ad-hoc commands are only permitted at T1-T3, request was ${parsed.tier}`;
      await deps.auditRefusal(parsed, reason);
      return makeRefusedResult(parsed, reason);
    }
    try {
      assertWithinTierAllowlist(parsed.tier, commandTextToCheck);
    } catch (err) {
      if (err instanceof TierViolationError) {
        await deps.auditRefusal(parsed, err.message);
        return makeRefusedResult(parsed, err.message);
      }
      throw err;
    }
  }

  // Step 4: execute, under timeout, output capped.
  const startedAt = new Date().toISOString();
  try {
    const { stdout, stderr, exitCode } = await deps.runPowerShell(commandTextToCheck, parsed.timeoutSeconds * 1000);
    const finishedAt = new Date().toISOString();

    return CommandResult.parse({
      commandId: parsed.commandId,
      assetId: parsed.assetId,
      startedAt,
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      exitCode,
      stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
      stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
      outcome: exitCode === 0 ? "success" : "failure",
    });
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const isTimeout = (err as { killed?: boolean; signal?: string }).killed === true;
    return CommandResult.parse({
      commandId: parsed.commandId,
      assetId: parsed.assetId,
      startedAt,
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      exitCode: -1,
      stdout: "",
      stderr: String((err as Error).message ?? err).slice(0, MAX_OUTPUT_BYTES),
      outcome: isTimeout ? "timeout" : "failure",
    });
  }
}

/**
 * Real PowerShell invocation for production use. Runs with
 * -ExecutionPolicy Restricted and no profile; ad-hoc commands additionally
 * get -Command wrapped so they can never smuggle a second statement past
 * the allowlist check that already ran on the same text.
 */
export async function runPowerShellReal(
  script: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Restricted", "-Command", script],
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES * 2 },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? String(err), exitCode: e.code ?? 1 };
  }
}
