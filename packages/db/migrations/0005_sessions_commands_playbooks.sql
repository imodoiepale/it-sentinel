-- Every remote-desktop and terminal session, and every elevated command run.
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  operator_id uuid not null references auth.users(id),
  ticket_ref text,
  mode text not null check (mode in ('view','control','terminal')),
  reason text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  bytes_transferred bigint default 0,
  recording_ref text
);
create index sessions_asset_idx on public.sessions (asset_id, started_at desc);
comment on table public.sessions is 'session.service.ts writes this row before minting a token; the browser never receives a credential.';

-- Every elevated execution, full transcript. See apps/agent-node/src/exec/runspace.ts.
create table public.command_runs (
  id uuid primary key default gen_random_uuid(),
  command_id uuid not null unique,
  asset_id uuid not null references public.assets(id) on delete cascade,
  operator_id uuid not null references auth.users(id),
  ticket_ref text,
  tier text not null check (tier in ('T0','T1','T2','T3','T4','T5','T6')),
  kind text not null check (kind in ('signed_script','adhoc_powershell','service_action')),
  script_id text,
  script_sha256 text,
  command_text text,
  approvals jsonb not null default '[]',
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  exit_code integer,
  stdout text,
  stderr text,
  outcome text check (outcome in ('success','failure','timeout','refused')),
  refusal_reason text,
  verification jsonb,
  created_at timestamptz not null default now()
);
create index command_runs_asset_idx on public.command_runs (asset_id, created_at desc);

create table public.playbooks (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  category text not null, -- 'printer','network','enquest','windows','security'
  tier text not null check (tier in ('T2','T3','T4','T5')),
  version text not null,
  sha256 text not null,
  script_path text not null,
  preconditions jsonb not null default '[]',
  timeout_seconds integer not null default 60,
  idempotent boolean not null default true,
  rollback_defined boolean not null default false,
  required_approvals integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.playbook_runs (
  id uuid primary key default gen_random_uuid(),
  playbook_id uuid not null references public.playbooks(id),
  command_run_id uuid references public.command_runs(id),
  asset_id uuid not null references public.assets(id) on delete cascade,
  operator_id uuid references auth.users(id),
  incident_id uuid references public.incidents(id),
  outcome text check (outcome in ('success','failure','timeout','refused','rolled_back')),
  ran_at timestamptz not null default now()
);
