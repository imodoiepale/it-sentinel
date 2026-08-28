import { T6_DENY_PATTERNS } from "@it-sentinel/contracts";

/**
 * The T6 hard deny list, compiled to pattern matchers against actual
 * PowerShell command text. This is checked FIRST, before the tier
 * allowlist, and is unreachable by role, tier, or any instruction embedded
 * in a script's own output — it is plain data-driven regex matching, not
 * something an LLM or operator input can talk its way around.
 *
 * Two-reviewer rule applies to this file per the plan: a change here needs
 * a second reviewer, same as executor.ts.
 */

interface DenyRule {
  pattern: (typeof T6_DENY_PATTERNS)[number];
  test: RegExp;
}

const DENY_RULES: DenyRule[] = [
  { pattern: "disable_edr", test: /Set-MpPreference.*-Disable(RealtimeMonitoring|IOAVProtection|BehaviorMonitoring)\s+\$?true/i },
  { pattern: "disable_edr", test: /Uninstall.*(Defender|WindowsDefender|MsMpEng)/i },
  { pattern: "disable_antivirus", test: /Stop-Service\s+.*(WinDefend|MsMpEng|Antivirus)/i },
  { pattern: "disable_firewall", test: /Set-NetFirewallProfile.*-Enabled\s+False/i },
  { pattern: "disable_firewall", test: /netsh\s+advfirewall\s+set\s+.*state\s+off/i },
  { pattern: "delete_audit_log", test: /Clear-EventLog|wevtutil\s+(cl|clear-log)/i },
  { pattern: "delete_audit_log", test: /(DELETE|TRUNCATE)\s+FROM\s+.*audit_log/i },
  { pattern: "edit_audit_log", test: /UPDATE\s+.*audit_log/i },
  { pattern: "delete_session_recording", test: /Remove-Item.*\.(recording|rec)\b/i },
  { pattern: "read_vault_secret", test: /vault\.decrypted_secrets|decrypt_credential_for_session/i },
  { pattern: "transmit_credential", test: /ConvertFrom-SecureString.*-AsPlainText|Get-Credential.*\|\s*Out-File/i },
  { pattern: "expose_vnc_public", test: /New-NetFirewallRule.*-LocalPort\s+5900.*-RemoteAddress\s+Any/i },
  { pattern: "expose_rdp_public", test: /New-NetFirewallRule.*-LocalPort\s+3389.*-RemoteAddress\s+Any/i },
  { pattern: "create_inbound_firewall_rule", test: /New-NetFirewallRule.*-Direction\s+Inbound/i },
  { pattern: "create_account", test: /New-LocalUser|net\s+user\s+\S+\s+\S+\s+\/add/i },
  { pattern: "grant_privilege", test: /Add-LocalGroupMember.*-Group\s+["']?Administrators/i },
  { pattern: "modify_own_policy", test: /policy\/deny-list\.ts|tier-resolver\.ts/i },
  { pattern: "delete_user_data", test: /Remove-Item.*-Recurse.*-Force.*\\Users\\[^\\]+\\(Documents|Desktop|Pictures)/i },
  { pattern: "delete_mailbox", test: /Remove-Mailbox|Remove-MsolUser/i },
  { pattern: "delete_backup", test: /Remove-Item.*\.(bak|backup)\b/i },
  { pattern: "format_volume", test: /Format-Volume|format\s+[a-zA-Z]:/i },
  { pattern: "diskpart_destructive", test: /diskpart/i },
  { pattern: "run_unsigned_download", test: /Invoke-WebRequest.*-OutFile.*\.(exe|ps1|bat)|iwr.*\|\s*iex/i },
];

export function matchDenyPattern(commandText: string): string | null {
  for (const rule of DENY_RULES) {
    if (rule.test.test(commandText)) return rule.pattern;
  }
  return null;
}

export { DENY_RULES };
