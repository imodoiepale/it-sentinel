import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CommandRequest, CommandResult } from "@it-sentinel/contracts";
import { hashScriptContent } from "@it-sentinel/contracts/script-hash";
import { matchDenyPattern } from "./deny-list.js";
import { assertWithinTierAllowlist, TierViolationError } from "./tier-resolver.js";
import { resolveApp, UnknownAppError, launchIsVisible } from "./app-launcher.js";
import { resolveService, serviceCommandFor, UnknownServiceError } from "./service-actions.js";

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
 *      all appear in that tier's allowlist. T4 is the single exception: it
 *      runs arbitrary PowerShell, having paid for it with operator password
 *      re-authentication instead. Step 1 still applies to it in full.
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
    // Line-ending-normalized, matching generate-manifests.ts exactly. A
    // raw byte hash here would refuse every script on a Windows checkout,
    // where git converts the repo's LF to CRLF on disk.
    const actualHash = hashScriptContent(content);

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

  if (parsed.kind === "app_launch") {
    if (!parsed.appId) {
      const reason = "app_launch request missing appId";
      await deps.auditRefusal(parsed, reason);
      return makeRefusedResult(parsed, reason);
    }
    try {
      // The command text is taken from the allowlist table, NOT from the
      // request — so the deny-list check below still runs against real
      // executable text, and a caller cannot smuggle anything through appId.
      commandTextToCheck = resolveApp(parsed.appId).command;
    } catch (err) {
      if (err instanceof UnknownAppError) {
        await deps.auditRefusal(parsed, err.message);
        return makeRefusedResult(parsed, err.message);
      }
      throw err;
    }
  }

  if (parsed.kind === "service_action") {
    if (!parsed.serviceName || !parsed.serviceAction) {
      const reason = "service_action request missing serviceName or serviceAction";
      await deps.auditRefusal(parsed, reason);
      return makeRefusedResult(parsed, reason);
    }

    /**
     * T3 Remediate is the floor. Starting or stopping a service changes the
     * machine's state — it is not an inspection — so it must not be reachable
     * from the read-only tiers, and unlike adhoc_powershell this kind never
     * reaches the tier allowlist below to be told so. T3's allowlist already
     * carries Start-/Stop-/Restart-Service, which is where the floor comes
     * from; T4 and T5 sit above it and are permitted for the same reason.
     */
    if (parsed.tier !== "T3" && parsed.tier !== "T4" && parsed.tier !== "T5") {
      const reason = `service actions change machine state and require T3 or above, request was ${parsed.tier}`;
      await deps.auditRefusal(parsed, reason);
      return makeRefusedResult(parsed, reason);
    }

    try {
      // Both halves of the command text come from fixed tables, NOT from the
      // request — so the deny-list check below still runs against real
      // executable text, and a caller cannot smuggle anything through
      // serviceName. This is also what makes "stop defender" a T6 refusal
      // rather than something the allowlist has to remember to exclude.
      commandTextToCheck = serviceCommandFor(parsed.serviceAction, resolveService(parsed.serviceName));
    } catch (err) {
      if (err instanceof UnknownServiceError) {
        await deps.auditRefusal(parsed, err.message);
        return makeRefusedResult(parsed, err.message);
      }
      throw err;
    }
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
    if (parsed.tier === "T4") {
      /**
       * T4 — Operator Console. THE ONE TIER THAT RUNS ARBITRARY POWERSHELL.
       *
       * T4 deliberately trades the cmdlet allowlist for re-authentication:
       * the control plane will not stamp an elevation reference onto a
       * dispatch unless the operator re-entered their password in the last
       * five minutes and the single-use token it minted was still unspent.
       * That is the whole of what T4 buys — reach in exchange for proof that
       * a human is present, not a relaxation of anything.
       *
       * WHAT T4 DOES NOT TRADE AWAY: the T6 deny-list. It ran above, on this
       * exact text, unconditionally, BEFORE this branch was reachable —
       * disabling EDR, clearing an event log, creating an account, opening
       * RDP to the world, or editing deny-list.ts / tier-resolver.ts is
       * refused at T4 exactly as it is at T1. There is no ordering, tier, or
       * role by which arbitrary execution gets in front of that check, and
       * test/executor.t4-elevated.adversarial.test.ts drives every known
       * attack at T4 to keep it that way.
       *
       * The reference is a truncated one-way hash of the elevation token,
       * never the token, so the secret that unlocked the dispatch never
       * reaches the machine or the queue. The agent cannot verify a password
       * itself, so this marker is not the authorisation — the control plane's
       * consumed token is. Requiring it here is what makes a hand-built or
       * replayed bare T4 envelope, one that never passed through the
       * elevation path, refusable at the point of execution too.
       */
      const elevationRef = parsed.args["elevationRef"];
      if (!/^[0-9a-f]{32}$/.test(elevationRef ?? "")) {
        const reason =
          "T4 ad-hoc execution requires an operator re-authentication reference; this dispatch carried none";
        await deps.auditRefusal(parsed, reason);
        return makeRefusedResult(parsed, reason);
      }
    } else if (parsed.tier !== "T1" && parsed.tier !== "T2" && parsed.tier !== "T3") {
      const reason = `ad-hoc commands are only permitted at T1-T4, request was ${parsed.tier}`;
      await deps.auditRefusal(parsed, reason);
      return makeRefusedResult(parsed, reason);
    } else {
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
  }

  /**
   * Backstop against the silent no-op. service_action shipped in the
   * contract before this file handled it, so every such request fell through
   * every branch above with commandTextToCheck still "" — the deny list
   * matched nothing, no allowlist applied, and the executor ran an empty
   * script and reported success. "Restarted the print spooler" with nothing
   * restarted is worse than an error, because nobody goes looking.
   *
   * Each kind is handled above now, but the next kind added to CommandKind
   * would reintroduce exactly this, so the invariant is enforced here rather
   * than left to the memory of whoever adds it: nothing empty ever executes.
   */
  if (commandTextToCheck.trim() === "") {
    const reason = `${parsed.kind} request produced no command text to execute`;
    await deps.auditRefusal(parsed, reason);
    return makeRefusedResult(parsed, reason);
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
      // A GUI app launched from session 0 runs but is invisible on the
      // interactive desktop. Reporting a bare "success" there would be
      // misleading — the operator would be told a window opened when
      // nobody can see one.
      verification:
        parsed.kind === "app_launch"
          ? {
              checked: true,
              passed: exitCode === 0 && launchIsVisible(),
              detail: launchIsVisible()
                ? "launched in the interactive desktop session"
                : "process started in session 0 (agent is running as a service) — it will NOT be visible on the machine's screen",
            }
          : undefined,
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
