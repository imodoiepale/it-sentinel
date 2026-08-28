# 03 — Architecture

## System diagram

```
                    ┌──────────────────────────────────┐
                    │      IT COMMAND CENTER (web)     │   apps/web — Next.js
                    │  Dashboard · Voice · AI · Tickets │
                    │  Terminal · Files · Reports · VNC │
                    └────────────────┬─────────────────┘
                       Supabase Realtime │ HTTPS │ WSS
                    ┌────────────────┴─────────────────┐
                    │       CONTROL PLANE (Fastify)     │   apps/control-plane
                    │  Ingest · Session Broker · Orch.   │
                    │  Policy · Tickets · Vault · Notify │
                    └────────────────┬─────────────────┘
          ┌──────────────────────────┼──────────────────────────┐
     ┌────▼─────┐              ┌────▼─────┐              ┌─────▼────┐
     │ Branch 01│              │ Branch 02│     ...      │    HQ    │
     │ agent-*  │              │ agent-*  │              │ agent-*  │
     │ TightVNC │              │ TightVNC │              │ TightVNC │
     └──────────┘              └──────────┘              └──────────┘

                    ┌──────────────────────────────────┐
                    │       RELAY (apps/relay)          │   RFB clean-room engine
                    │  browser WS <-> TCP to TightVNC   │
                    └──────────────────────────────────┘

                    ┌──────────────────────────────────┐
                    │  SENTINEL AGENT (apps/sentinel-   │   AI tool-calling harness
                    │  agent) — T0-T2 read-only tools   │
                    └──────────────────────────────────┘

                    ┌──────────────────────────────────┐
                    │  SUPABASE POSTGRES (packages/db)  │   schema, RLS, realtime,
                    │  pg_partman · pg_cron · pgmq ·    │   vault, pg_trgm, pgvector
                    │  supabase_vault · pgvector         │
                    └──────────────────────────────────┘
```

Agents connect **outbound only** — no inbound port forwarding at any branch, ever. The relay is the only thing that opens an inbound-from-browser, outbound-to-branch connection, and it does so per-session, brokered, and audited.

## The monorepo

pnpm workspace, defined in `pnpm-workspace.yaml` (`apps/*`, `packages/*`).

```
apps/
  web/              Next.js 15 App Router — the console
  control-plane/    Fastify — registry, monitoring, orchestrator, policy, tickets, notify
  relay/            RFB↔WebSocket engine (Node)
  agent-node/       Node 26 + PowerShell, LocalSystem Windows service
  agent-dotnet/     .NET 8 Worker Service — scaffolded, not built (SDK not installed)
  agent-less/       PowerShell 7 fan-out collector, no branch install
  sentinel-agent/   AI tool-calling harness, executor, tier policy
packages/
  contracts/        Zod schemas — the single wire contract
  db/               Migrations, seed, RLS tests
  scripts/          The signed playbook library (.ps1 + manifests)
infra/              (reserved for local dev stack — docker-compose, etc.)
```

## Why these specific technology choices

| Decision | What the plan called for | What actually got built | Why |
|---|---|---|---|
| Control plane framework | NestJS | **Fastify** | Same module boundaries (ingest, session, orchestrator, policy, tickets, vault, notify), far less boilerplate, faster to get to working/tested code. A pragmatic swap, called out explicitly rather than silently deviating. |
| Remote access | TightVNC-adjacent | **Clean-room RFB from RFC 6143** | No TightVNC source touched at any point, so no GPL question ever arises. See [08-relay-and-remote-access.md](./08-relay-and-remote-access.md). |
| Telemetry history | TimescaleDB hypertables | **`pg_partman` daily partitions + BRIN index** | TimescaleDB extension is not available on this Supabase org — verified via `list_extensions` before designing around it. |
| AI model | Hosted API model | **DeepSeek, self-hosted, open-weight (planned)** — currently a `StubPlanner` | Keeps branch logs/screens on-premises; the harness is built and tested before any model is attached, real or stub. |
| Command queue | Direct HTTP dispatch | **`pgmq`** | Store-and-forward — a command survives a WAN drop and is delivered when the branch reconnects. |

## Data flow: a heartbeat

1. A collector (`agent-node`, `agent-less`, or eventually `agent-dotnet`) gathers machine state and POSTs a `HeartbeatPayload` (`packages/contracts/src/heartbeat.ts`) to `POST /v1/heartbeat`.
2. `apps/control-plane/src/ingest/ingest.service.ts` validates it against the shared Zod schema — a malformed heartbeat is rejected with 400, never silently accepted.
3. If the asset doesn't exist yet, it's auto-provisioned under its branch (matched by `voice_aliases`/slug) — this is what lets `agent-less` give day-one coverage without hand-seeding hundreds of rows.
4. `asset_health` is upserted (the small, realtime-subscribed table), `telemetry` gets a new row (the large, partitioned history table), and `checks` gets one row per printer/diagnostic finding.
5. Alert rules run inline — a fingerprinted, deduplicated `alerts` row is raised if Enquest or endpoint security isn't healthy.
6. The web console's single Realtime subscription (`apps/web/lib/realtime.ts`) picks up the `asset_health`/`alerts` change and the UI updates with no polling.

## Data flow: a remote session

1. Operator clicks "Start Remote Session" in the Machine Workspace.
2. `POST /v1/sessions` → `session.service.ts` checks policy (role, site scope), writes a `sessions` row, and mints a single-use token stored in `_session_tokens` (service-role-only table, no RLS policies at all).
3. The browser connects `wss://relay/session/<token>`.
4. The relay redeems the token (`redeem_session_token()` — atomic, once-only), decrypts the credential via `decrypt_credential_for_session()` (service-role-only RPC), opens a TCP socket to the branch machine, completes the RFB/VNC-auth handshake on the operator's behalf, and discards the plaintext password.
5. From that point the relay is a dumb byte pipe; noVNC in the browser speaks the rest of the protocol directly to the real TightVNC Server.

Full detail: [08-relay-and-remote-access.md](./08-relay-and-remote-access.md).

## Data flow: an elevated command

1. Operator (or the AI, or a voice command) requests an action through the console.
2. `POST /v1/commands` → `orchestrator.service.ts` checks policy tier against the operator's role ceiling, and — for T3+ or anything touching more than 5 assets — requires confirmation/approval.
3. The `CommandRequest` is enqueued on `pgmq`'s `agent_commands` queue (survives a WAN drop) and recorded in `command_runs`.
4. The target `agent-node` instance long-polls `GET /v1/commands/poll`, receives the message, and hands it to `executor.ts` — **the only place a command becomes an actual process**.
5. The executor checks, in order: T6 deny-list match → signed-script hash pinning (if applicable) → tier allowlist → execute under timeout with output capped.
6. The result is POSTed back to `POST /v1/commands/:msgId/result`, recorded with full transcript, and the queue message is acked.

Full detail: [05-security-model.md](./05-security-model.md) and [07-agents.md](./07-agents.md).

## Where to look for what

| I want to... | Look at |
|---|---|
| Add a field to telemetry | `packages/contracts/src/heartbeat.ts`, then the matching migration in `packages/db/migrations` |
| Add a new API endpoint | `apps/control-plane/src/main.ts` and the relevant service under `apps/control-plane/src/*` |
| Add a new elevated action | `packages/scripts/library` (a new signed script) or `apps/agent-node/src/exec/tier-resolver.ts` (a new ad-hoc allowlist entry) |
| Add a new AI tool | `apps/sentinel-agent/src/tools/registry.ts`, then `runTool()` in `executor.ts` |
| Change a console screen | `apps/web/app/page.tsx` and `apps/web/components/*` |
| Understand what's actually enforced vs just described | [05-security-model.md](./05-security-model.md) |
