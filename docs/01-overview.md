# 01 — Overview

## The problem this replaces

Before this system, supporting a branch meant: open TightVNC Viewer, type an IP address from a spreadsheet, dismiss a Caps Lock warning, type a shared password that every technician knows, and hope the machine you land on is actually the one with the problem. There was no fleet view, no telemetry history, no audit trail, and no way to know a branch was in trouble until someone there picked up the phone.

## The loop this system implements

Every part of IT Sentinel exists in service of one loop:

> **Monitor → Detect → Diagnose → Recommend → Remediate → Remote Control → Verify → Document**

Remote control — the TightVNC button — is one step in that loop, not the product. The product is a continuously-updated picture of 44+ branches that tells a technician *which* machine is broken, *what* is probably wrong, *whether it's happened before*, *what fixed it last time*, and gives them governed tools to act — with everything they do recorded.

## What actually exists right now

| Layer | What it does | Where |
|---|---|---|
| Telemetry collectors | Three interchangeable agents report machine health every 60s | `apps/agent-node`, `apps/agent-less`, `apps/agent-dotnet` |
| Control plane | Validates telemetry, brokers sessions, dispatches commands, enforces policy | `apps/control-plane` |
| Database | Postgres/Supabase — schema, RLS, realtime, the credential vault | `packages/db` |
| Web console | Branch sidebar, fleet table, machine workspace, voice, remote viewer | `apps/web` |
| Remote access engine | Clean-room RFB relay — browser-based, credential never reaches the browser | `apps/relay` |
| Elevated execution | Constrained, deny-listed, hash-pinned PowerShell execution on LocalSystem | `apps/agent-node/src/exec` |
| Script library | Signed, hashed playbooks for common fixes | `packages/scripts` |
| AI assistant | Tool-calling harness with a hard-coded permission ceiling | `apps/sentinel-agent` |
| Shared contract | The one schema every collector and the control plane agree on | `packages/contracts` |

## Design principles that show up everywhere in the code

**The executor is authoritative, the prompt is not.** Nothing in this system — not the AI, not the terminal UI, not a voice command — executes anything directly. Everything becomes a typed request that a separate executor validates against a compiled deny list before anything runs. This is true twice over: once for the AI agent (`apps/sentinel-agent/src/executor.ts`) and once for elevated shell execution (`apps/agent-node/src/exec/executor.ts`).

**Nobody holds the password.** The VNC credential lives in Supabase Vault. It is decrypted exactly once, server-side, by the relay, to complete a handshake — and never returned to a browser, logged, or given to the AI agent. See [08-relay-and-remote-access.md](./08-relay-and-remote-access.md) and [05-security-model.md](./05-security-model.md).

**RLS is the backstop, not the only line of defense.** Every table denies access by default. An operator sees exactly what their `site_access` grants permit — proven live, not just asserted, in [12-testing-and-verification.md](./12-testing-and-verification.md).

**Staleness is not health.** A machine that stops reporting flips to a distinct `stale` state within 5 minutes (`pg_cron` sweep) — it never silently stays green because nobody's heard from it.

**Nothing here copies TightVNC.** The remote-access engine is a clean-room implementation of RFB 3.8 from the published RFC, not a fork or adaptation of TightVNC/TigerVNC/RealVNC/MightyViewer source. TightVNC Server keeps running unmodified on every branch PC as the protocol endpoint. See [08-relay-and-remote-access.md](./08-relay-and-remote-access.md).

## Who this is for

- **A technician** opens the console, sees which branches are broken, clicks through to a machine, and gets a remote session or a terminal without ever knowing a password.
- **An IT manager** reads the daily digest, sees cause-analytics ("Enquest sync 31%, printer queues 22%..."), and knows where to focus.
- **A security/compliance reviewer** reads the audit log and can trace every privileged action back to an operator, a ticket, and a policy decision.
- **A developer** extending this system starts at [03-architecture.md](./03-architecture.md), then the specific layer they're touching.
