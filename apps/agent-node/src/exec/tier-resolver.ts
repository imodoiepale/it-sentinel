import { ActionTier } from "@it-sentinel/contracts";

/**
 * Per-tier cmdlet allowlists for ad-hoc PowerShell input. Signed scripts
 * from packages/scripts bypass this (they run FullLanguage, gated instead
 * by Authenticode signature + SHA256 hash pinning — see runspace.ts) but
 * any ad-hoc command an operator or the terminal UI sends is parsed and
 * matched against exactly these verbs, never passed through as an opaque
 * string to the shell.
 */

const T1_INSPECT_CMDLETS = ["Get-ChildItem", "Get-Content", "Test-Path", "Get-ItemProperty", "Test-NetConnection"];

const T2_DIAGNOSE_CMDLETS = [
  ...T1_INSPECT_CMDLETS,
  "Test-Connection",
  "Resolve-DnsName",
  "Get-Service",
  "Get-Process",
  "Get-EventLog",
  "Get-WinEvent",
  "sfc",
  "tracert",
  "nslookup",
  "Get-Printer",
  "Get-PrintJob",
];

const T3_REMEDIATE_CMDLETS = [
  ...T2_DIAGNOSE_CMDLETS,
  "Restart-Service",
  "Start-Service",
  "Stop-Service",
  "Clear-PrintQueue",
  "Remove-PrintJob",
  "Clear-DnsClientCache",
  "ipconfig",
  "Restart-Spooler",
];

/**
 * T4 is absent by design, not by oversight. The Operator Console tier runs
 * arbitrary PowerShell — an allowlist entry for it would either be a lie
 * (a finite list that does not describe what T4 permits) or an every-cmdlet
 * list that anyone reading this file would reasonably mistake for one. The
 * executor branches around this table at T4 and gates on the operator's
 * password re-authentication instead; the T6 deny-list, which is not an
 * allowlist and lives in deny-list.ts, still applies there in full.
 */
const TIER_CMDLET_ALLOWLIST: Record<string, readonly string[]> = {
  T1: T1_INSPECT_CMDLETS,
  T2: T2_DIAGNOSE_CMDLETS,
  T3: T3_REMEDIATE_CMDLETS,
};

export class TierViolationError extends Error {
  constructor(
    public readonly requestedTier: ActionTier,
    public readonly offendingToken: string,
  ) {
    super(`command uses "${offendingToken}", which is not in the ${requestedTier} allowlist`);
  }
}

/**
 * Extracts leading PowerShell verbs/commands from a command string. Simple
 * on purpose: this only needs to catch the cmdlet name, not fully parse
 * PowerShell syntax — the deny list (checked separately, first) is what
 * catches attempts to obscure intent.
 */
function extractCommandTokens(commandText: string): string[] {
  return commandText
    .split(/[;|&]/)
    .map((seg) => seg.trim().split(/\s+/)[0])
    .filter((tok): tok is string => Boolean(tok));
}

/** Throws TierViolationError if any token in the command isn't allowed at this tier. */
export function assertWithinTierAllowlist(tier: "T1" | "T2" | "T3", commandText: string): void {
  const allowlist = TIER_CMDLET_ALLOWLIST[tier];
  const tokens = extractCommandTokens(commandText);
  for (const token of tokens) {
    const matches = allowlist.some((allowed) => token.toLowerCase() === allowed.toLowerCase());
    if (!matches) {
      throw new TierViolationError(tier as ActionTier, token);
    }
  }
}

export { TIER_CMDLET_ALLOWLIST };
