-- asset_health: current denormalized state, one row per asset — what the
-- dashboard subscribes to via Supabase Realtime. Cheap, small, high-churn.
create table public.asset_health (
  asset_id uuid primary key references public.assets(id) on delete cascade,
  online boolean not null default false,
  status text not null default 'unknown' check (status in ('healthy','warning','critical','unknown','stale')),
  network_latency_ms numeric,
  ram_usage numeric check (ram_usage between 0 and 100),
  disk_free_percent numeric check (disk_free_percent between 0 and 100),
  printer_status text not null default 'unknown' check (printer_status in ('healthy','warning','critical','unknown','stale')),
  email_status text not null default 'unknown' check (email_status in ('healthy','warning','critical','unknown','stale')),
  endpoint_security_status text not null default 'unknown' check (endpoint_security_status in ('healthy','warning','critical','unknown','stale')),
  tightvnc_status text not null default 'unknown' check (tightvnc_status in ('running','stopped','not_installed','unreachable','unknown')),
  enquest_status text not null default 'unknown' check (enquest_status in ('healthy','warning','critical','unknown','stale')),
  agent_version text,
  last_heartbeat_at timestamptz,
  updated_at timestamptz not null default now()
);
comment on table public.asset_health is 'Denormalized current state. pg_cron staleness sweep flips this to status=stale when last_heartbeat_at ages out — never silently stays healthy.';

-- telemetry: history, daily-partitioned via pg_partman (our TimescaleDB
-- replacement), BRIN-indexed for cheap range scans over an append-only table.
create table public.telemetry (
  id uuid not null default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  recorded_at timestamptz not null default now(),
  payload jsonb not null, -- full HeartbeatPayload from packages/contracts
  primary key (id, recorded_at)
) partition by range (recorded_at);

-- Seed partition so inserts work immediately; pg_partman takes over maintenance below.

create index telemetry_asset_time_brin_idx on public.telemetry using brin (asset_id, recorded_at);

select partman.create_parent(
  p_parent_table => 'public.telemetry',
  p_control => 'recorded_at',
  p_interval => '1 day',
  p_premake => 7
);

update partman.part_config
set retention = '90 days', retention_keep_table = false
where parent_table = 'public.telemetry';

-- checks: per-check results for the 20 additional monitored services plus
-- the diagnostic modules (printer chain, Enquest health, network score...).
create table public.checks (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references public.assets(id) on delete cascade,
  site_id uuid references public.sites(id) on delete cascade,
  check_type text not null, -- e.g. 'printer_chain','enquest_sync','dns','vpn_tunnel','backup_job'
  status text not null check (status in ('healthy','warning','critical','unknown','stale')),
  fault_class text, -- printer chain: pc_problem | network_problem | physical_printer_problem | driver_problem
  detail jsonb not null default '{}',
  checked_at timestamptz not null default now()
);
create index checks_asset_type_idx on public.checks (asset_id, check_type, checked_at desc);
create index checks_site_type_idx on public.checks (site_id, check_type, checked_at desc);
