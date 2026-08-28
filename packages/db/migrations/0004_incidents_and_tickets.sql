-- Alert → incident → resolution, with fingerprinting for dedup and recurrence.
create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references public.assets(id) on delete cascade,
  site_id uuid references public.sites(id) on delete cascade,
  fingerprint text not null, -- stable hash of (check_type, asset_id, fault_class) for dedup
  severity text not null check (severity in ('p1','p2','p3','p4')),
  title text not null,
  detail jsonb not null default '{}',
  status text not null default 'open' check (status in ('open','acknowledged','resolved','suppressed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index alerts_fingerprint_idx on public.alerts (fingerprint, created_at desc);
create index alerts_status_idx on public.alerts (status) where status = 'open';

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  ticket_ref text unique,
  asset_id uuid references public.assets(id) on delete set null,
  site_id uuid references public.sites(id) on delete set null,
  fingerprint text not null,
  severity text not null check (severity in ('p1','p2','p3','p4')),
  title text not null,
  category text, -- 'enquest_sync','printer_queue','network','disk_capacity','email','other'
  status text not null default 'open' check (status in ('open','in_progress','resolved','closed')),
  owner_id uuid references auth.users(id),
  resolution_summary text,
  resolution_success boolean,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index incidents_fingerprint_idx on public.incidents (fingerprint, opened_at desc);
comment on table public.incidents is 'recurrence.service.ts groups by fingerprint to surface "seen N times, previous fix succeeded M%".';

create table public.incident_events (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  event_type text not null, -- 'created','assigned','comment','command_run','session_started','resolved'
  actor_id uuid references auth.users(id),
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index incident_events_incident_idx on public.incident_events (incident_id, created_at);
