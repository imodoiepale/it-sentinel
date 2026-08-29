# 13 — Deployment

**This system is deployed and running.**

| Piece | Where | Status |
|---|---|---|
| Control plane | https://it-sentinel-control-plane.onrender.com | Live, Render Starter, Frankfurt |
| Web console | https://it-sentinel-web.onrender.com | Live, Render Starter, Frankfurt |
| Database | Supabase `ncyerayycwkqytznnkrs`, `eu-west-1`, Postgres 17 | Live |
| Voice agent | ElevenLabs Conversational AI, 15 webhook tools | Live |
| VNC relay | The command laptop, on the branch LAN | Not cloud-hosted, and cannot be |

The relay is the one piece that is deliberately not deployed: it opens TCP
connections to branch machines on private `192.168.x.x` addresses, which no
cloud host can route to. That is a routing fact, not a configuration choice.

Deployment is defined by `render.yaml`; `scripts/configure-render.mjs` pushes
the secrets from your local `.env` files without printing them.

## Environment variables, by app

Every app that needs configuration ships a `.env.example` — the authoritative list. Summary:

### `apps/control-plane`
```
SUPABASE_URL=https://ncyerayycwkqytznnkrs.supabase.co
SUPABASE_SERVICE_ROLE_KEY=            # secret — never commit, never paste in chat
PORT=8787
WHATSAPP_ACCESS_TOKEN=                # optional — no-ops with a log line if unset
WHATSAPP_PHONE_NUMBER_ID=
PORTAL_URL=http://localhost:3210
DAILY_DIGEST_HOUR_UTC=5
DAILY_DIGEST_RECIPIENTS=              # comma-separated E.164 numbers; empty = scheduler stays idle
```

### `apps/relay`
```
SUPABASE_URL=https://ncyerayycwkqytznnkrs.supabase.co
SUPABASE_SERVICE_ROLE_KEY=            # secret — same key, same rules
RELAY_PORT=8788
RELAY_VNC_PORT=5900
```

### `apps/web`
```
NEXT_PUBLIC_SUPABASE_URL=https://ncyerayycwkqytznnkrs.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...   # safe for the browser — this is its purpose
NEXT_PUBLIC_CONTROL_PLANE_URL=http://localhost:8787
```

### `apps/agent-less`
```
CONTROL_PLANE_URL=http://localhost:8787
AGENTLESS_POLL_INTERVAL_MS=60000
```

### `apps/agent-node`
```
CONTROL_PLANE_URL=http://localhost:8787
HEARTBEAT_INTERVAL_MS=60000
COMMAND_POLL_INTERVAL_MS=5000
SENTINEL_BRANCH_SLUG=junction-mall
SENTINEL_BRANCH_NAME=Junction Mall
SENTINEL_SCRIPTS_DIR=                 # defaults to packages/scripts/library relative to the built dist/
```

### `apps/sentinel-agent`
```
SUPABASE_URL=https://ncyerayycwkqytznnkrs.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...   # NOT service-role — this process must only ever have operator-scoped access
SENTINEL_AGENT_PORT=8789
```

## The one hard rule: never put the service-role key anywhere it can reach a browser

`SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security entirely — it's the actual security boundary for the credential vault, the session tokens, and the command queue. It belongs in exactly two places: `apps/control-plane` and `apps/relay`. Never in `apps/web`, never in `apps/sentinel-agent` (which deliberately uses the operator's own JWT instead — see [10-sentinel-agent.md](./10-sentinel-agent.md)), never committed, never in a log line, never pasted into a chat session.

## Intended topology (not yet built)

The plan calls for:
- Control plane and relay behind a real public URL (HTTPS/WSS), reachable from branch agents (outbound only from the branch side) and from operator browsers.
- `agent-node` installed per branch as a Windows Service — see `apps/agent-node/README`-equivalent notes in [07-agents.md](./07-agents.md) and the real `install-service.ps1` / `service-install.ts` scripts.
- The daily-digest scheduler currently runs **inside the control-plane process** rather than via `pg_cron`+`pg_net`, specifically because Supabase's cloud-hosted `pg_cron` cannot reach a `localhost` control plane — see [06-control-plane-api.md](./06-control-plane-api.md). Once control-plane has a real public URL, migrating this to a `pg_cron` job calling `POST /v1/reports/daily/whatsapp` via `pg_net` is a legitimate, low-risk follow-on.
- A GPU host for the Sentinel Agent's eventual real model (vLLM/Ollama-served DeepSeek) — not provisioned.

## Database — already live, no deployment step needed there

The Supabase project (`ncyerayycwkqytznnkrs`) is already active with all 24+ migrations applied, RLS verified, and 44 branches seeded. Nothing further is required on the database side to start development against it — see [04-database.md](./04-database.md) and [02-getting-started.md](./02-getting-started.md) for access setup.

## Local development stack

`infra/` is reserved for a `docker-compose.yml` + local Supabase CLI stack per the original plan — **not yet created**. Right now, local development happens against the live Supabase project directly (see [02-getting-started.md](./02-getting-started.md)), which is simpler for now but means local dev and "production" share one database. Building out a genuinely local stack is worth doing before this goes anywhere near real branch machines.

## Before this touches a real branch

Do not point `agent-node`, `agent-less`, or the relay at a real branch's TightVNC Server or run a signed script against a real machine without:
1. Reading [05-security-model.md](./05-security-model.md) in full.
2. Testing against one non-POS machine first — never a live till during trading hours (this is stated explicitly in the plan's own testing discipline).
3. Confirming the `credentials` row for that asset was created via `store_credential()` (never by hand-inserting a plaintext value anywhere).
