# 11 — Scripts Library

`packages/scripts/library` — signed, hashed, versioned PowerShell scripts. This is what the plan calls the safer alternative to unrestricted shell access, and it's what the executor's hash-pinning (see [05-security-model.md](./05-security-model.md)) actually checks against.

## What exists today — 8 real scripts, seeded into the database

| Script | Category | Tier | What it does |
|---|---|---|---|
| `restart-spooler.ps1` | Printer | T3 | Restarts the Print Spooler service, verifies it's running afterward |
| `clear-print-queue.ps1` | Printer | T3 | Clears stuck jobs from every printer's queue |
| `test-print.ps1` | Printer | T2 | Sends a test page to the default printer |
| `flush-dns.ps1` | Network | T3 | Clears the DNS client cache |
| `ping-gateway.ps1` | Network | T2 | Pings the default gateway, reports latency and packet loss |
| `enquest-check-services.ps1` | Enquest | T2 | Reports whether the Enquest process and any `Enquest*`-named services are running |
| `windows-system-health.ps1` | Windows | T2 | Uptime, free memory %, system-drive free % |
| `defender-status.ps1` | Security | T2 | Real-time protection state, signature age, tamper-protection state |

Every script is genuinely idempotent and read-only-or-safely-reversible — none has a defined rollback because none needs one at the tier it's registered at (a T3 service restart doesn't require rollback semantics the way a T4 config change would).

## The manifest system

`packages/scripts/generate-manifests.ts` — run via `pnpm manifest` — computes the SHA-256 of every `.ps1` file and writes a matching `<slug>.manifest.json` next to it, with `scriptId`, `category`, `tier`, `version`, `sha256`, `scriptPath`, `timeoutSeconds`, `idempotent`, `rollbackDefined`, `requiredApprovals`.

**Regenerate manifests after any edit to a script.** The executor refuses to run a script whose on-disk hash doesn't match its manifest — that's not a formality, it's the actual security check (see the three tampering scenarios proven in `apps/agent-node/test/executor.adversarial.test.ts`).

## How this connects to the database

The same 8 scripts' metadata (slug, name, category, tier, version, sha256, script_path, timeout, idempotent, rollback_defined, required_approvals) is seeded into the `playbooks` table (migration `0023_seed_playbooks.sql`) — this is the metadata the console's future playbook-library UI would read, and what `playbook_runs` would reference once dispatched via the orchestrator with `kind: "signed_script"`.

## Categories the plan calls for that don't have scripts yet

Windows: Disk Cleanup, Windows Update Status, Event Log Scan, SFC/DISM Diagnostic. Security: Definition Update, Quick Scan, Firewall Status. Network: Renew DHCP, Trace Route, Test Internet. Enquest: Refresh Sync, Inspect Logs, Check Database, Restart Approved Component. Printer: Detect Printer IP. Adding one means: write the `.ps1` (read-only unless the tier genuinely needs otherwise), run `pnpm manifest`, add the corresponding row to a new migration seeding `playbooks`.
