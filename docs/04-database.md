# 04 — Database

Postgres via Supabase. Project: **`IT COMMAND CENTER`**, ref `oohuqbxrwsjfgzigefam`, region `eu-central-1`, Postgres 17.

## Migrations — applied in order, this is the schema's real history

All in `packages/db/migrations/`, applied live via the Supabase MCP `apply_migration` tool, one concern per file:

| File | What it does |
|---|---|
| `0001_extensions.sql` | `pgcrypto`, `pg_trgm`, `vector`, `pgaudit`, `pg_partman` (own schema — see gotcha below), `pg_cron`, `pgmq` |
| `0002_core_registry.sql` | `sites`, `assets`, `site_access` |
| `0003_health_and_telemetry.sql` | `asset_health`, partitioned `telemetry`, `checks` |
| `0004_incidents_and_tickets.sql` | `alerts`, `incidents`, `incident_events` |
| `0005_sessions_commands_playbooks.sql` | `sessions`, `command_runs`, `playbooks`, `playbook_runs` |
| `0006_audit_and_knowledge.sql` | `audit_log` (insert-only), `knowledge` (pgvector) |
| `0007_rls.sql` | Deny-by-default RLS on every table, `has_site_access()`, `current_agent_asset_id()` |
| `0008_staleness_sweep.sql` | The 5-minute `pg_cron` job that flips silent agents to `stale` |
| `0009_realtime.sql` | Adds exactly 4 tables to the `supabase_realtime` publication |
| `0010_command_queue.sql` | `pgmq.create('agent_commands')` |
| `0011_credential_vault.sql` | `credentials`, `credential_rotation_log`, `store_credential()`, `decrypt_credential_for_session()` |
| `0012_security_hardening.sql` | Fixes from `get_advisors`: RLS on pg_partman's child partitions (they don't inherit it), locked-down `SECURITY DEFINER` functions |
| `0020_session_tokens.sql` | `_session_tokens` (redeem-once, zero RLS policies — service-role only), `redeem_session_token()` |
| `0021_command_queue_wrappers.sql` | `public` wrapper RPCs around `pgmq` (not PostgREST-exposed by default) |
| `0024_voice_branch_resolution.sql` | `resolve_branch_by_voice()` — `pg_trgm` similarity, `SECURITY INVOKER` so RLS still applies |

Seed data: `packages/db/seed/branches.csv` → generated `001_sites.sql`, applied as migration `0013_seed_sites`. Playbook metadata seeded as `0023_seed_playbooks`.

## Extension gotchas hit while building this (useful if you're touching migrations)

- **`pg_partman` needs its own schema.** `create extension pg_partman` alone fails — it must be `create schema partman; create extension pg_partman with schema partman;`.
- **`pg_partman` 5.x rejects the old string intervals.** `p_interval => 'daily'` errors with "no longer supported" — use `'1 day'` (a real Postgres interval literal).
- **`pg_partman` 5.x dropped the `p_type` parameter.** `create_parent(..., p_type => 'native', ...)` errors "not a valid partitioning type" — just omit it.
- **RLS does not inherit to `pg_partman`'s child partitions.** Each daily partition is its own relation with its own RLS flag; enabling RLS on the parent table does nothing for PostgREST access to `telemetry_p20260827` etc. `0012_security_hardening.sql`'s `secure_telemetry_partitions()` function fixes existing partitions and is scheduled via `pg_cron` to run daily, right after `partman.run_maintenance_proc()`, so every new partition gets secured before it can hold data.
- **`REVOKE` on an extension-owned function silently no-ops if you're not the owner.** Two of `pgaudit`'s internal trigger-handler functions are owned by `supabase_admin`; attempts to revoke `EXECUTE` from `anon`/`authenticated` on them run without error but change nothing. This is a known, accepted residual finding — see [14-status-and-roadmap.md](./14-status-and-roadmap.md).

## Table reference

### Registry
- **`sites`** — the 44 branches (seeded from the provided spreadsheet). `voice_aliases text[]` disambiguates spoken names — see [09-web-console.md](./09-web-console.md#voice).
- **`assets`** — machines/devices per site. `asset_type` discriminates `pos`/`server`/`workstation`/`printer`/`switch`/`ap`/`ups`/`nvr`/`camera` so non-Windows device types slot in without a migration.
- **`site_access`** — which operator has which role on which site. This is what RLS's `has_site_access()` checks.

### Health and history
- **`asset_health`** — current denormalized state, one row per asset. This is the *only* table the console's realtime subscription needs for the fleet table — small, cheap, high-churn.
- **`telemetry`** — full history, `PARTITION BY RANGE (recorded_at)`, daily partitions, 90-day retention, BRIN-indexed. This replaces the TimescaleDB hypertable the original plan called for (not available on this Supabase org).
- **`checks`** — one row per diagnostic finding (printer fault-chain classification, Enquest sync state, etc.), with `fault_class` for the printer chain's PC/network/physical/driver classification.

### Incidents
- **`alerts`** — raw detections, deduplicated by `fingerprint` while `status = 'open'`.
- **`incidents`** — the ticket. `fingerprint` + `resolution_success` is what `recurrence.service.ts` uses to answer "seen N times, previous fix worked M%."
- **`incident_events`** — timeline entries on an incident.

### Sessions and commands
- **`sessions`** — every remote/terminal session. Written *before* a token is minted; the browser never receives a credential (see `_session_tokens` below).
- **`_session_tokens`** — single-use, short-lived tokens. **RLS enabled with zero policies** — deny-all by construction for `anon`/`authenticated`; only the service-role connection (the relay) can touch it.
- **`command_runs`** — full transcript of every elevated execution: actor, target, tier, exit code, stdout/stderr, outcome.
- **`playbooks`** / **`playbook_runs`** — the signed script library's metadata and execution history.

### Security
- **`credentials`** — metadata only (label, type, rotation policy). The actual secret is never a column here.
- **`credential_rotation_log`** — evidence of rotation events.
- **`audit_log`** — append-only (`UPDATE`/`DELETE` revoked from all roles). Every policy decision, refusal, and privileged action lands here.
- **`knowledge`** — `vector(1536)` embeddings over runbooks/resolved incidents, HNSW-indexed, for the Sentinel Agent's future RAG.

## Row Level Security — the actual model, not the aspiration

Every table denies by default. Two helper functions do the real work:

- **`has_site_access(site_id)`** — `SECURITY DEFINER`, checks `site_access` for `auth.uid()`. Used in nearly every read policy.
- **`current_agent_asset_id()`** — reads the `agent_asset_id` custom JWT claim. A device's JWT is scoped to write only its own asset's rows in `asset_health`/`telemetry`/`checks` — nothing else.

**This was verified live, not just written and trusted.** See [12-testing-and-verification.md](./12-testing-and-verification.md) for the actual transaction-level proof: an operator scoped to one site sees exactly that site and zero of another's assets; an agent JWT bound to one asset is blocked (`insufficient_privilege`) from writing another asset's health or telemetry.

## Realtime publication

Exactly four tables, deliberately narrow — `apps/web/lib/realtime.ts` subscribes to exactly these and nothing more:

```
public.asset_health
public.alerts
public.incidents
public.sessions
```

## The credential vault, precisely

`credentials` (metadata) + Supabase Vault (`vault.secrets`, libsodium-encrypted at rest) + two functions:

- **`store_credential(...)`** — `SECURITY INVOKER`, callable by `it_manager`/`security_admin` roles (per the insert RLS policy on `credentials`). Writes the secret into the vault and a metadata row; never returns the secret.
- **`decrypt_credential_for_session(credential_id, session_id)`** — `SECURITY DEFINER`, **`EXECUTE` granted to `service_role` only**, revoked from `anon`/`authenticated`. This is the only path that ever returns a plaintext credential, and it requires a real, already-minted `sessions` row to succeed. The relay (`apps/relay/src/main.ts`) is the only caller.

## The command queue

`pgmq.create('agent_commands')` — one shared queue, messages carry a `CommandRequest` envelope with the target `assetId`. Three `public`-schema wrapper functions (`enqueue_command`, `dequeue_commands`, `ack_command`) exist because `pgmq`'s own schema isn't exposed to PostgREST; all three are `service_role`-only, same pattern as the vault.

## Running the RLS test suite

`packages/db/test/rls.test.sql` is a `pgtap` suite meant for `pg_prove` / `supabase test db` locally. Against the live project (where those tools aren't available through the MCP connection), the same assertions were run manually as real transactions with role-switching — see [12-testing-and-verification.md](./12-testing-and-verification.md) for the exact results.
