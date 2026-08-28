-- Device registry: sites (the 43+ branches) and assets (machines/devices per site).

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  extension text,
  primary_ip inet,
  region text not null default 'Nairobi',
  criticality text not null default 'standard' check (criticality in ('standard', 'critical')),
  voice_aliases text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.sites is 'The branch/HQ directory. voice_aliases feeds pg_trgm resolution for the voice agent.';

create index sites_voice_aliases_trgm_idx on public.sites using gin (voice_aliases);
create index sites_name_trgm_idx on public.sites using gin (name gin_trgm_ops);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  hostname text not null,
  ip inet,
  mac text,
  asset_type text not null default 'workstation'
    check (asset_type in ('pos','server','workstation','printer','switch','ap','ups','nvr','camera')),
  vnc_port integer default 5900,
  credential_id uuid, -- references a supabase_vault secret; rotation needs no schema change
  criticality text not null default 'standard' check (criticality in ('standard', 'critical')),
  serial text,
  model text,
  manufacturer text,
  agent_collector text check (agent_collector in ('agent-node','agent-dotnet','agent-less')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, hostname)
);
comment on table public.assets is 'Every machine and device under a site. type discriminator lets cameras/switches/UPS slot in without migration.';

create index assets_site_id_idx on public.assets (site_id);
create index assets_last_seen_idx on public.assets (last_seen_at);

-- Which operators can see which sites. Deny-by-default RLS below joins through this.
create table public.site_access (
  operator_id uuid not null references auth.users(id) on delete cascade,
  site_id uuid not null references public.sites(id) on delete cascade,
  role text not null check (role in ('l1_support','l2_support','l3_sysadmin','security_admin','it_manager','auditor')),
  granted_at timestamptz not null default now(),
  primary key (operator_id, site_id)
);
