# 07 — Telemetry Agents

Three interchangeable collectors, all emitting the identical `HeartbeatPayload` (`packages/contracts/src/heartbeat.ts`) to `POST /v1/heartbeat`. A given branch can be covered by any one of them, and switching which collector reports for a machine is invisible to the control plane and console.

## Comparison

| | `agent-node` | `agent-less` | `agent-dotnet` |
|---|---|---|---|
| Install required on branch machine | Yes — Windows Service | **No** | Yes — Windows Service |
| Runtime | Node 26 + PowerShell shell-out | Node 26 + PowerShell remoting (from HQ) | .NET 8 Worker Service |
| Privilege | LocalSystem (no UAC, survives reboot) | Dedicated AD service account over WinRM | LocalSystem |
| Can execute elevated commands | **Yes** — the only one with `apps/agent-node/src/exec` | No — read-only collection only | Not yet built |
| Status | Built, tested (26/26 adversarial), real service installer | Built, tested (2/2), real PS collector | **Scaffolded only — never compiled** (.NET SDK not installed) |
| Rollout role | Replaces `agent-less` per site as deployed | Day-one coverage for all 44 branches, zero install | Would become the standard once signed, for best native fidelity |

## `agent-node` — the primary collector, and the only one that executes commands

`apps/agent-node/src/main.ts` runs two independent loops:

1. **Heartbeat loop** — runs `collect.ps1` locally every 60s (`HEARTBEAT_INTERVAL_MS`), posts the result.
2. **Command poll loop** — long-polls `GET /v1/commands/poll` every 5s (`COMMAND_POLL_INTERVAL_MS`) and hands anything it gets to `executeCommand()` in `src/exec/executor.ts` — **nothing here bypasses that gate**.

### Installing it for real

1. `pnpm build` in `apps/agent-node` — produces `dist/`.
2. `install-service.ps1 -BranchSlug junction-mall -BranchName "Junction Mall" -ControlPlaneUrl https://control.it-sentinel.internal` — stages files to `C:\Program Files\IT Sentinel\agent-node`, sets machine-scoped env vars.
3. `node dist/service-install.js` — registers the Windows Service via `node-windows` (`src/service-install.ts`), running as LocalSystem by default, auto-starts.

### `collect.ps1` — what it actually gathers

Read-only, CIM/WMI-based. Every field it collects, and only these — deliberately no more:

Machine identity, CPU/RAM/storage, Windows version/activation/uptime/reboot-pending, network (gateway, DNS, internet reachability/latency), TightVNC install/service/port state, Defender status, per-printer state (driver, port, queue depth, error state), Outlook process presence (**never message content**), Enquest process/service presence, required-service state, pending update count, recent Application/System event-log errors, logged-in user/session state.

## `agent-less` — zero-install, day-one coverage

`apps/agent-less/src/main.ts` fans out over PS-remoting to every branch's `primary_ip` (fetched from `GET /v1/sites`, so it needs no database credentials of its own), running the same `collect.ps1` remotely via `Invoke-Command`, transforming the result into a contract-valid heartbeat, and posting it.

This is what gives all 44 branches coverage from day one, before a single `agent-node` service has been installed anywhere — `agent-node` then supersedes it site by site as it's deployed.

Real read-only collector, real tests (`apps/agent-less/test/transform.test.ts`) proving the PS-output-to-heartbeat transform produces contract-valid results, including correct printer-fault classification.

## `agent-dotnet` — scaffolded, not built

**The .NET 8 SDK is not installed in this environment**, confirmed via `dotnet --version` (command not found). `apps/agent-dotnet/src/Program.cs` is a real, from-scratch Worker Service skeleton — never copied, never compiled, never tested. `apps/agent-dotnet/README.md` documents exactly what picking this up involves: install the SDK, port the collectors natively via `System.Management` instead of shelling out to PowerShell, and — critically — port the deny-list/tier-allowlist logic from `agent-node`'s `exec/` folder 1:1, since that logic is the actual security boundary regardless of which language implements it.

## The elevated execution model, in brief

Covered in full in [05-security-model.md](./05-security-model.md). The short version: `agent-node`'s LocalSystem privilege is what makes real diagnosis possible (why won't a service start, what's actually in the Enquest log), and it is constrained by a compiled T6 deny list checked first, hash-pinned signed scripts, and a per-tier cmdlet allowlist for anything ad-hoc — proven by a 26/26 adversarial test suite, not just described.
